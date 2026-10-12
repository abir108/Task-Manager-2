/* Team KPI report downloads: Excel (.xlsx), PDF (through the browser's print dialog) and CSV.
   Everything follows what is selected on the Report page: the member (one person or everyone)
   and the date range. Loaded after script.js, which provides the report data and helpers. */

const REPORT_NOTES = [
  "Completion = tasks done ÷ tasks assigned. On-time rate = tasks done by their due date ÷ tasks done that had a due date.",
  "KPI average = points earned ÷ points shared out, over the tasks the admin has scored. Points earned = total points earned.",
  "A task is counted in the period of its due date (or the day it was finished or created if it has none).",
  "A task assigned to several members counts once for each of them."
];

function reportScope() {
  const memberId = document.getElementById("report-kpi-member").value;
  const member = reportMembersCache.find(m => m.id === memberId) || null;
  return {
    memberId,
    member,
    memberLabel: member ? member.name : "All members",
    periodLabel: reportPeriodFilter ? reportPeriodFilter.label() : "All time"
  };
}

const fractionOf = (a, b) => (b ? a / b : null);

function sumKpis(ks) {
  const t = { assigned: 0, done: 0, ontime: 0, late: 0, overdue: 0, pointsEarned: 0, pointsScoredMax: 0, pointsTasks: 0 };
  ks.forEach(k => Object.keys(t).forEach(key => { t[key] += k[key]; }));
  t.pointsEarned = Math.round(t.pointsEarned * 100) / 100;
  return t;
}

function kpiFractions(k) {
  return {
    completion: fractionOf(k.done, k.assigned),
    onTime: fractionOf(k.ontime, k.ontime + k.late),
    average: fractionOf(k.pointsEarned, k.pointsScoredMax)
  };
}

function reportDateText(ts) {
  return ts ? new Date(ts).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "";
}

function reportTaskRows(memberId, tasks) {
  const byId = new Map(reportAllTasksCache.map(t => [t.id, t]));
  const projectName = id => { const p = reportAllProjectsCache.find(x => x.id === id); return p ? p.name : "—"; };
  return tasks.map(t => {
    const parent = t.parentId ? byId.get(t.parentId) : null;
    const done = t.status === "done";
    const score = done ? memberScore(t, memberId) : null;
    const share = t.shares ? t.shares[memberId] : undefined;
    return {
      project: projectName(t.projectId),
      task: t.title,
      parent: parent ? parent.title : "",
      due: t.dueDate ? formatDate(t.dueDate) : "",
      dueKey: t.dueDate || "9999-12-31",
      completed: done ? reportDateText(t.completedAt) : "",
      status: done ? "Done" : "Open",
      result: kpiTaskOutcome(t).label,
      total: t.points == null ? null : t.points,
      share: share === undefined ? null : share,
      earned: score ? score.earned : null,
      pct: score && score.share > 0 ? score.earned / score.share : null
    };
  }).sort((a, b) => a.project.localeCompare(b.project) || a.dueKey.localeCompare(b.dueKey) || a.task.localeCompare(b.task));
}

/* Everything a download needs, for the member and period currently selected. */
function buildTeamReport() {
  const scope = reportScope();
  const members = scope.member ? [scope.member] : reportMembersCache.slice();
  const groups = members.map(member => {
    const tasks = reportMemberTasks(member.id);
    const k = computeKpi(tasks, member.id);
    return { member, k, f: kpiFractions(k), rows: reportTaskRows(member.id, tasks) };
  }).sort((a, b) => b.k.assigned - a.k.assigned || a.member.name.localeCompare(b.member.name));
  const totals = sumKpis(groups.map(g => g.k));
  return { ...scope, generated: new Date(), groups, totals, totalsF: kpiFractions(totals) };
}

function reportFileName(report, ext) {
  const who = report.member ? report.member.name : "All-members";
  const clean = s => String(s).replace(/[^A-Za-z0-9ঀ-৿]+/g, "-").replace(/^-|-$/g, "");
  return `CloudTask-Report_${clean(who)}_${clean(report.periodLabel)}.${ext}`;
}

const reportStamp = d => d.toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const averageStyle = f => (f === null ? "center" : f >= 0.8 ? "good" : f >= 0.5 ? "warn" : "bad");

/* ---------- Excel ---------- */
function exportReportXlsx() {
  const report = buildTeamReport();
  const cols = 12;
  const rows = [];
  const merges = [];
  const blank = () => rows.push([]);

  rows.push([{ v: "CloudTask — Team KPI Report", s: "title" }]);
  rows.push([{ v: "CloudTech Bookkeeping", s: "subtitle" }]);
  blank();
  [["Members", report.memberLabel], ["Period", report.periodLabel], ["Generated", reportStamp(report.generated)]].forEach(([label, value]) => {
    rows.push([{ v: label, s: "label" }, { v: value, s: "text" }, { s: "text" }, { s: "text" }]);
    merges.push(`B${rows.length}:D${rows.length}`);
  });
  blank();

  const headerRow = rows.length + 1;
  rows.push(["Member", "Assigned", "Done", "On time", "Late", "Overdue", "Completion", "On-time rate", "KPI average", "Points earned", "Tasks scored"]
    .map((v, i) => ({ v, s: i === 0 ? "headerLeft" : "header" })));
  const pctCell = f => (f === null ? { v: "—", s: "center" } : { v: f, s: "pct" });
  report.groups.forEach(g => {
    rows.push([
      { v: g.member.name, s: "text" },
      { v: g.k.assigned, s: "int" }, { v: g.k.done, s: "int" }, { v: g.k.ontime, s: "int" }, { v: g.k.late, s: "int" }, { v: g.k.overdue, s: "int" },
      pctCell(g.f.completion), pctCell(g.f.onTime),
      g.f.average === null ? { v: "—", s: "center" } : { v: g.f.average, s: averageStyle(g.f.average) },
      { v: g.k.pointsEarned, s: "num" }, { v: g.k.pointsTasks, s: "int" }
    ]);
  });
  const lastData = rows.length;
  if (report.groups.length > 1) {
    const t = report.totals, tf = report.totalsF;
    const totalPct = f => (f === null ? { v: "—", s: "totalText" } : { v: f, s: "totalPct" });
    rows.push([
      { v: "Team total", s: "totalText" },
      { v: t.assigned, s: "totalInt" }, { v: t.done, s: "totalInt" }, { v: t.ontime, s: "totalInt" }, { v: t.late, s: "totalInt" }, { v: t.overdue, s: "totalInt" },
      totalPct(tf.completion), totalPct(tf.onTime), totalPct(tf.average),
      { v: t.pointsEarned, s: "totalNum" }, { v: t.pointsTasks, s: "totalInt" }
    ]);
  }
  blank();
  rows.push([{ v: "How to read this report", s: "subtitle" }]);
  REPORT_NOTES.forEach(note => { rows.push([{ v: note, s: "muted" }]); });

  merges.push("A1:H1", "A2:H2");
  const sheets = [{
    name: "Summary",
    widths: [30, 11, 9, 9, 9, 10, 12, 13, 13, 14, 13],
    heights: { 0: 30 },
    freeze: headerRow,
    filter: { row: headerRow, fromCol: 0, toCol: cols - 2, lastRow: Math.max(lastData, headerRow) },
    merges,
    rows
  }];

  report.groups.filter(g => g.rows.length || report.member).forEach(g => {
    const r = [];
    const m = [];
    r.push([{ v: g.member.name, s: "title" }]);
    r.push([{ v: [g.member.email, report.periodLabel].filter(Boolean).join("   ·   "), s: "muted" }]);
    r.push([]);
    r.push(["Assigned", "Done", "Completion", "On-time rate", "KPI average", "Points earned"].map(v => ({ v, s: "header" })));
    r.push([
      { v: g.k.assigned, s: "int" }, { v: g.k.done, s: "int" }, pctCell(g.f.completion), pctCell(g.f.onTime),
      g.f.average === null ? { v: "—", s: "center" } : { v: g.f.average, s: averageStyle(g.f.average) },
      { v: g.k.pointsEarned, s: "num" }
    ]);
    r.push([]);
    const taskHeader = r.length + 1;
    r.push(["Project", "Task", "Subtask of", "Due", "Completed", "Status", "Result", "Task points", "Share", "Earned", "%"]
      .map((v, i) => ({ v, s: i < 3 ? "headerLeft" : "header" })));
    g.rows.forEach(t => {
      r.push([
        { v: t.project, s: "textWrap" }, { v: t.task, s: "textWrap" }, { v: t.parent, s: "textWrap" },
        { v: t.due, s: "center" }, { v: t.completed, s: "center" }, { v: t.status, s: "center" }, { v: t.result, s: "center" },
        t.total === null ? { v: "", s: "center" } : { v: t.total, s: "num" },
        t.share === null ? { v: "", s: "center" } : { v: t.share, s: "num" },
        t.earned === null ? { v: "", s: "center" } : { v: t.earned, s: "num" },
        t.pct === null ? { v: "", s: "center" } : { v: t.pct, s: "pct" }
      ]);
    });
    if (!g.rows.length) r.push([{ v: "No tasks in this period.", s: "muted" }]);
    m.push("A1:H1");
    sheets.push({
      name: g.member.name,
      widths: [24, 38, 24, 13, 13, 10, 18, 12, 11, 11, 10],
      heights: { 0: 30 },
      freeze: 0,
      filter: g.rows.length ? { row: taskHeader, fromCol: 0, toCol: 10, lastRow: taskHeader + g.rows.length } : null,
      merges: m,
      rows: r
    });
  });

  XlsxLite.download(reportFileName(report, "xlsx"), sheets);
  showToast(`Excel report downloaded (${report.groups.length === 1 ? report.memberLabel : report.groups.length + " members"})`);
}

/* ---------- CSV ---------- */
function exportReportCsv() {
  const report = buildTeamReport();
  const header = ["Member", "Project", "Task", "Subtask of", "Due", "Completed", "Status", "Result", "Task points", "Share", "Earned", "Percent"];
  const lines = [header];
  report.groups.forEach(g => {
    g.rows.forEach(t => lines.push([
      g.member.name, t.project, t.task, t.parent, t.due, t.completed, t.status, t.result,
      t.total === null ? "" : t.total, t.share === null ? "" : t.share, t.earned === null ? "" : t.earned,
      t.pct === null ? "" : Math.round(t.pct * 1000) / 10 + "%"
    ]));
  });
  const esc = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const blob = new Blob(["﻿" + lines.map(r => r.map(esc).join(",")).join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = reportFileName(report, "csv");
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast("CSV downloaded");
}

/* ---------- PDF (print) ---------- */
function reportPrintHtml(report) {
  const e = escapeHtml;
  const pct = f => (f === null ? "—" : Math.round(f * 1000) / 10 + "%");
  const tone = f => (f === null ? "" : f >= 0.8 ? "good" : f >= 0.5 ? "warn" : "bad");
  const num = n => (n === null || n === undefined ? "" : String(Math.round(n * 100) / 100));

  const summaryRows = report.groups.map(g => `
    <tr>
      <td class="l">${e(g.member.name)}</td><td>${g.k.assigned}</td><td>${g.k.done}</td><td>${g.k.ontime}</td><td>${g.k.late}</td><td>${g.k.overdue}</td>
      <td>${pct(g.f.completion)}</td><td>${pct(g.f.onTime)}</td><td class="${tone(g.f.average)}">${pct(g.f.average)}</td><td>${num(g.k.pointsEarned)}</td><td>${g.k.pointsTasks}</td>
    </tr>`).join("");
  const t = report.totals, tf = report.totalsF;
  const totalRow = report.groups.length > 1 ? `
    <tr class="total">
      <td class="l">Team total</td><td>${t.assigned}</td><td>${t.done}</td><td>${t.ontime}</td><td>${t.late}</td><td>${t.overdue}</td>
      <td>${pct(tf.completion)}</td><td>${pct(tf.onTime)}</td><td>${pct(tf.average)}</td><td>${num(t.pointsEarned)}</td><td>${t.pointsTasks}</td>
    </tr>` : "";

  const memberSections = report.groups.filter(g => g.rows.length || report.member).map(g => `
    <section class="pr-member">
      <h2>${e(g.member.name)}</h2>
      <p class="pr-muted">${e([g.member.email, report.periodLabel].filter(Boolean).join("  ·  "))}</p>
      <div class="pr-kpis">
        <div><b>${g.k.assigned}</b><span>Assigned</span></div>
        <div><b>${g.k.done}</b><span>Done</span></div>
        <div><b>${pct(g.f.completion)}</b><span>Completion</span></div>
        <div><b>${pct(g.f.onTime)}</b><span>On-time rate</span></div>
        <div class="${tone(g.f.average)}"><b>${pct(g.f.average)}</b><span>KPI average</span></div>
        <div><b>${num(g.k.pointsEarned)}</b><span>Points earned</span></div>
      </div>
      ${g.rows.length ? `
      <table class="pr-table pr-tasks">
        <thead><tr><th class="l">Project</th><th class="l">Task</th><th>Due</th><th>Completed</th><th>Result</th><th>Task pts</th><th>Share</th><th>Earned</th><th>%</th></tr></thead>
        <tbody>${g.rows.map(r => `
          <tr>
            <td class="l">${e(r.project)}</td>
            <td class="l">${r.parent ? `<span class="pr-muted">↳ ${e(r.parent)} › </span>` : ""}${e(r.task)}</td>
            <td>${e(r.due)}</td><td>${e(r.completed)}</td><td>${e(r.result)}</td>
            <td>${num(r.total)}</td><td>${num(r.share)}</td><td>${num(r.earned)}</td><td>${r.pct === null ? "" : pct(r.pct)}</td>
          </tr>`).join("")}
        </tbody>
      </table>` : `<p class="pr-muted">No tasks in this period.</p>`}
    </section>`).join("");

  return `
    <div class="pr-head">
      <img class="pr-logo" src="logo.png" alt="">
      <div><div class="pr-title">Team KPI Report</div><div class="pr-sub">CloudTask · CloudTech Bookkeeping</div></div>
    </div>
    <table class="pr-meta">
      <tr><th>Members</th><td>${e(report.memberLabel)}</td><th>Period</th><td>${e(report.periodLabel)}</td><th>Generated</th><td>${e(reportStamp(report.generated))}</td></tr>
    </table>
    <h2>Summary</h2>
    <table class="pr-table">
      <thead><tr><th class="l">Member</th><th>Assigned</th><th>Done</th><th>On time</th><th>Late</th><th>Overdue</th><th>Completion</th><th>On-time rate</th><th>KPI average</th><th>Points earned</th><th>Tasks scored</th></tr></thead>
      <tbody>${summaryRows}${totalRow}</tbody>
    </table>
    <div class="pr-notes"><b>How to read this report</b>${REPORT_NOTES.map(n => `<p>${e(n)}</p>`).join("")}</div>
    ${memberSections}`;
}

function exportReportPdf() {
  const report = buildTeamReport();
  let host = document.getElementById("print-report");
  if (!host) {
    host = document.createElement("div");
    host.id = "print-report";
    document.body.appendChild(host);
  }
  host.innerHTML = reportPrintHtml(report);
  const previousTitle = document.title;
  document.title = reportFileName(report, "pdf").replace(/\.pdf$/, "");   // becomes the suggested file name
  const finish = () => {
    document.title = previousTitle;
    host.innerHTML = "";
    window.removeEventListener("afterprint", finish);
  };
  window.addEventListener("afterprint", finish);
  setTimeout(() => window.print(), 200);
}

/* ---------- Download menu ---------- */
(function wireReportDownload() {
  const button = document.getElementById("btn-report-download");
  const menu = document.getElementById("report-dl-menu");
  if (!button || !menu) return;
  const close = () => { menu.classList.add("u-hidden"); button.setAttribute("aria-expanded", "false"); };
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    const open = menu.classList.contains("u-hidden");
    if (open) {
      const scope = reportScope();
      document.getElementById("report-dl-scope").textContent = `${scope.memberLabel} · ${scope.periodLabel}`;
    }
    menu.classList.toggle("u-hidden", !open);
    button.setAttribute("aria-expanded", String(open));
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-fmt]");
    if (!item) return;
    close();
    try {
      if (item.dataset.fmt === "xlsx") exportReportXlsx();
      else if (item.dataset.fmt === "pdf") exportReportPdf();
      else exportReportCsv();
    } catch (err) {
      console.error(err);
      alert("Could not create the report: " + err.message);
    }
  });
  document.addEventListener("click", close);
  document.addEventListener("keydown", (event) => { if (event.key === "Escape") close(); });
})();
