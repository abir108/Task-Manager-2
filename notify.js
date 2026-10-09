/* Task notifications over Slack and email.
   Nothing happens until it is configured (see the Notifications panel on the Team page
   or .env.example). A failed notification is logged and never breaks the request that
   triggered it.

   Events
     taskAssigned   -> each newly assigned member: Slack DM (found by email) and/or email
     statusChanged  -> admins, when a *member* changes a task's status: Slack (webhook,
                       channel or DM) and optionally email (NOTIFY_ADMIN_EMAIL=1) */
const { store } = require("./db");

const env = key => (process.env[key] || "").trim();
const SLACK_TIMEOUT_MS = 8000;

function config() {
  const smtpPort = Number(env("SMTP_PORT")) || 587;
  return {
    slackToken: env("SLACK_BOT_TOKEN"),
    slackWebhook: env("SLACK_WEBHOOK_URL"),
    slackAdminChannel: env("SLACK_ADMIN_CHANNEL"),
    slackApi: (env("SLACK_API_URL") || "https://slack.com/api").replace(/\/+$/, ""),
    smtpHost: env("SMTP_HOST"),
    smtpPort,
    smtpSecure: env("SMTP_SECURE") ? env("SMTP_SECURE").toLowerCase() === "true" : smtpPort === 465,
    smtpUser: env("SMTP_USER"),
    smtpPass: process.env.SMTP_PASS || "",
    smtpFrom: env("SMTP_FROM") || env("SMTP_USER"),
    smtpSelfSigned: env("SMTP_ALLOW_SELF_SIGNED") === "1",
    adminEmail: env("NOTIFY_ADMIN_EMAIL") === "1",
    appUrl: env("APP_URL").replace(/\/+$/, "")
  };
}

function status() {
  const c = config();
  return {
    slack: {
      memberDms: !!c.slackToken,
      adminTarget: c.slackWebhook ? "webhook" : (c.slackToken && c.slackAdminChannel) ? "channel" : c.slackToken ? "admin DMs" : null
    },
    email: { configured: !!(c.smtpHost && c.smtpFrom), host: c.smtpHost || null, adminCopies: c.adminEmail },
    appUrl: c.appUrl || null
  };
}

/* ---------- helpers ---------- */
const escHtml = s => String(s == null ? "" : s).replace(/[&<>"]/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
const escSlack = s => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const oneLine = s => String(s == null ? "" : s).replace(/[\r\n]+/g, " ").trim();

function prettyDate(dateStr) {
  if (!dateStr) return "No due date";
  const d = new Date(dateStr + "T12:00:00");
  return isNaN(d) ? dateStr : d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function ok(detail) { return { ok: true, detail: detail || "sent" }; }
function fail(err) { return { ok: false, detail: oneLine(err && err.message ? err.message : err) }; }

/* ---------- Slack ---------- */
async function slackCall(method, payload) {
  const c = config();
  const res = await fetch(`${c.slackApi}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${c.slackToken}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(`Slack ${method}: ${data.error || "HTTP " + res.status}`);
  return data;
}

const slackIdCache = new Map();
async function slackUserIdForEmail(email) {
  const key = email.toLowerCase();
  if (slackIdCache.has(key)) return slackIdCache.get(key);
  const c = config();
  const res = await fetch(`${c.slackApi}/users.lookupByEmail`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Authorization: `Bearer ${c.slackToken}` },
    body: new URLSearchParams({ email }).toString(),
    signal: AbortSignal.timeout(SLACK_TIMEOUT_MS)
  });
  const data = await res.json().catch(() => ({}));
  if (!data.ok) throw new Error(data.error === "users_not_found" ? `no Slack user with email ${email}` : `Slack users.lookupByEmail: ${data.error || "HTTP " + res.status}`);
  slackIdCache.set(key, data.user.id);
  return data.user.id;
}

async function slackDm(email, text) {
  if (!config().slackToken) return null;
  if (!email) return fail("member has no email");
  try {
    const userId = await slackUserIdForEmail(email);
    await slackCall("chat.postMessage", { channel: userId, text });
    return ok("DM sent");
  } catch (err) { return fail(err); }
}

async function slackAdmin(text, admins) {
  const c = config();
  try {
    if (c.slackWebhook) {
      const res = await fetch(c.slackWebhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(SLACK_TIMEOUT_MS)
      });
      if (!res.ok) throw new Error(`Slack webhook: HTTP ${res.status}`);
      return [ok("posted to webhook")];
    }
    if (!c.slackToken) return [];
    if (c.slackAdminChannel) {
      await slackCall("chat.postMessage", { channel: c.slackAdminChannel, text });
      return [ok(`posted to ${c.slackAdminChannel}`)];
    }
    return Promise.all(admins.map(a => slackDm(a.email, text)));
  } catch (err) { return [fail(err)]; }
}

/* ---------- Email ---------- */
let transporter = null;
let transporterKey = "";
function getTransporter() {
  const c = config();
  const key = [c.smtpHost, c.smtpPort, c.smtpSecure, c.smtpUser, c.smtpPass, c.smtpSelfSigned].join("|");
  if (!transporter || key !== transporterKey) {
    const nodemailer = require("nodemailer");
    transporter = nodemailer.createTransport({
      host: c.smtpHost,
      port: c.smtpPort,
      secure: c.smtpSecure,
      auth: c.smtpUser ? { user: c.smtpUser, pass: c.smtpPass } : undefined,
      tls: c.smtpSelfSigned ? { rejectUnauthorized: false } : undefined,
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 12000
    });
    transporterKey = key;
  }
  return transporter;
}

async function sendMail(to, subject, text, html) {
  const c = config();
  if (!c.smtpHost || !c.smtpFrom) return null;
  if (!to) return fail("no email address");
  try {
    await getTransporter().sendMail({ from: c.smtpFrom, to, subject: oneLine(subject), text, html });
    return ok("email sent");
  } catch (err) { return fail(err); }
}

function emailHtml(title, lines, linkUrl) {
  const rows = lines.map(l => `<tr><td style="padding:3px 0;color:#566690;font-size:13px">${escHtml(l[0])}</td><td style="padding:3px 0 3px 14px;color:#14214F;font-size:14px;font-weight:600">${escHtml(l[1])}</td></tr>`).join("");
  const button = linkUrl
    ? `<p style="margin:22px 0 0"><a href="${escHtml(linkUrl)}" style="background:#4382DF;color:#ffffff;text-decoration:none;font-weight:600;font-size:14px;padding:10px 20px;border-radius:8px;display:inline-block">Open Task Manager</a></p>`
    : "";
  return `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:520px;margin:0 auto;border:1px solid #DCE8EB;border-radius:14px;overflow:hidden">
  <div style="background:#112E81;color:#ffffff;padding:16px 22px;font-size:16px;font-weight:700">CloudTech Bookkeeping</div>
  <div style="padding:22px">
    <div style="font-size:18px;font-weight:700;color:#14214F;margin-bottom:12px">${escHtml(title)}</div>
    <table style="border-collapse:collapse">${rows}</table>${button}
  </div></div>`;
}

/* ---------- messages ---------- */
function taskContext(task, project, group) {
  const parent = task.parentId ? store.tasks.find(t => t.id === task.parentId) : null;
  return {
    title: oneLine(task.title),
    parentTitle: parent ? oneLine(parent.title) : "",
    project: project ? oneLine(project.name) : "",
    group: group ? oneLine(group.name) : ""
  };
}

async function taskAssigned({ task, project, group, actor, memberIds }) {
  const c = config();
  const ctx = taskContext(task, project, group);
  const actorName = actor ? oneLine(actor.name) : "Someone";
  const due = prettyDate(task.dueDate);
  const kind = ctx.parentTitle ? "subtask" : "task";

  for (const id of memberIds) {
    const member = store.members.find(m => m.id === id);
    if (!member || (actor && member.id === actor.id)) continue;

    const slackText = [
      `:clipboard: *New ${kind} assigned to you*`,
      `*${escSlack(ctx.title)}*${ctx.parentTitle ? ` (subtask of ${escSlack(ctx.parentTitle)})` : ""}`,
      `Project: ${escSlack(ctx.project)}${ctx.group ? " · " + escSlack(ctx.group) : ""}`,
      `Due: ${due}`,
      `Assigned by ${escSlack(actorName)}`,
      c.appUrl ? `<${c.appUrl}|Open Task Manager>` : ""
    ].filter(Boolean).join("\n");

    const lines = [["Task", ctx.title]];
    if (ctx.parentTitle) lines.push(["Subtask of", ctx.parentTitle]);
    lines.push(["Project", ctx.project + (ctx.group ? " · " + ctx.group : "")], ["Due", due], ["Assigned by", actorName]);
    const text = lines.map(l => `${l[0]}: ${l[1]}`).join("\n") + (c.appUrl ? `\n\n${c.appUrl}` : "");

    const results = await Promise.all([
      slackDm(member.email, slackText),
      sendMail(member.email, `New ${kind} assigned: ${ctx.title}`, `You have a new ${kind}.\n\n${text}`,
        emailHtml(`You have a new ${kind}`, lines, c.appUrl))
    ]);
    logResults("assigned", member.name, results);
  }
}

async function statusChanged({ task, project, group, actor, fromLabel, toLabel, isDone }) {
  const c = config();
  const admins = store.members.filter(m => m.role === "admin" && (!actor || m.id !== actor.id));
  if (!admins.length) return;
  const ctx = taskContext(task, project, group);
  const actorName = actor ? oneLine(actor.name) : "Someone";

  const slackText = [
    `${isDone ? ":white_check_mark:" : ":arrows_counterclockwise:"} *${escSlack(actorName)}* moved *${escSlack(ctx.title)}* from _${escSlack(fromLabel)}_ to *${escSlack(toLabel)}*`,
    `Project: ${escSlack(ctx.project)}${ctx.group ? " · " + escSlack(ctx.group) : ""}`,
    c.appUrl ? `<${c.appUrl}|Open Task Manager>` : ""
  ].filter(Boolean).join("\n");

  const results = await slackAdmin(slackText, admins);

  if (c.adminEmail) {
    const lines = [["Task", ctx.title], ["Project", ctx.project + (ctx.group ? " · " + ctx.group : "")], ["Changed by", actorName], ["Status", `${fromLabel} → ${toLabel}`]];
    const text = lines.map(l => `${l[0]}: ${l[1]}`).join("\n") + (c.appUrl ? `\n\n${c.appUrl}` : "");
    for (const admin of admins) {
      results.push(await sendMail(admin.email, `${actorName} updated: ${ctx.title} → ${toLabel}`, text, emailHtml("A task status changed", lines, c.appUrl)));
    }
  }
  logResults("status", "admins", results);
}

function logResults(event, who, results) {
  (Array.isArray(results) ? results : [results]).flat().filter(r => r && !r.ok).forEach(r => {
    console.warn(`[notify] ${event} -> ${who}: ${r.detail}`);
  });
}

/* Test from the Team page: tries every configured route and reports each result. */
async function sendTest(admin) {
  const c = config();
  const results = [];
  const text = ":bell: *Test notification* from CloudTech Task Manager. If you can read this, Slack is connected.";
  if (c.slackToken) results.push({ channel: "Slack direct message", ...(await slackDm(admin.email, text)) });
  if (c.slackWebhook || (c.slackToken && c.slackAdminChannel)) {
    const r = await slackAdmin(text, []);
    results.push({ channel: c.slackWebhook ? "Slack admin webhook" : "Slack admin channel", ...(r[0] || fail("nothing sent")) });
  }
  if (c.smtpHost && c.smtpFrom) {
    const lines = [["Result", "Email is connected"], ["Sent to", admin.email || "-"]];
    results.push({ channel: "Email", ...(await sendMail(admin.email, "Test notification from CloudTech Task Manager", "Email notifications are connected.", emailHtml("Test notification", lines, c.appUrl))) });
  }
  if (!results.length) results.push({ channel: "Setup", ok: false, detail: "Nothing is configured yet" });
  return results;
}

module.exports = { status, taskAssigned, statusChanged, sendTest };
