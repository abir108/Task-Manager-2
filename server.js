const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const { store, save, uid } = require("./db");

const app = express();
const PORT = process.env.PORT || 8790;
const isProduction = process.env.NODE_ENV === "production";

if (isProduction) app.set("trust proxy", 1);

let sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
  sessionSecret = crypto.randomBytes(32).toString("hex");
  if (isProduction) {
    console.warn("\nWARNING: SESSION_SECRET is not set. Using a random secret that changes on every restart, which will log everyone out each time the server restarts. Set SESSION_SECRET in your environment for production.\n");
  }
}

app.use(express.json({ limit: "5mb" }));
app.use(session({
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: isProduction, maxAge: 12 * 60 * 60 * 1000 }
}));

/* ---------- Login rate limiting ---------- */
const loginAttempts = new Map(); // key: lowercased name -> { count, lockedUntil }
const MAX_ATTEMPTS = 5;
const LOCK_MS = 60 * 1000;

function isLocked(key) {
  const rec = loginAttempts.get(key);
  return rec && rec.lockedUntil && rec.lockedUntil > Date.now();
}
function registerFailure(key) {
  const rec = loginAttempts.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + LOCK_MS;
    rec.count = 0;
  }
  loginAttempts.set(key, rec);
}
function clearFailures(key) {
  loginAttempts.delete(key);
}

/* ---------- Auth helpers ---------- */
function currentMember(req) {
  if (!req.session.userId) return null;
  return store.members.find(m => m.id === req.session.userId) || null;
}

function requireAuth(req, res, next) {
  const member = currentMember(req);
  if (!member) return res.status(401).json({ error: "Not logged in" });
  req.member = member;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.member.role !== "admin") return res.status(403).json({ error: "Admin access required" });
    next();
  });
}

function publicMember(m) {
  return { id: m.id, name: m.name, role: m.role, createdAt: m.createdAt };
}

function projectVisible(project, member) {
  if (member.role === "admin") return true;
  return project.memberIds.includes(member.id);
}

/* ---------- Auth routes ---------- */
app.post("/api/login", (req, res) => {
  const name = String(req.body.name || "").trim();
  const pin = String(req.body.pin || "").trim();
  if (!name || !pin) return res.status(400).json({ error: "Name and PIN are required" });

  const key = name.toLowerCase();
  if (isLocked(key)) return res.status(429).json({ error: "Too many attempts. Try again in a minute." });

  const member = store.members.find(m => m.name.toLowerCase() === key);
  if (!member || !bcrypt.compareSync(pin, member.pinHash)) {
    registerFailure(key);
    return res.status(401).json({ error: "Invalid name or PIN" });
  }
  clearFailures(key);
  req.session.userId = member.id;
  res.json({ member: publicMember(member) });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get("/api/me", (req, res) => {
  const member = currentMember(req);
  if (!member) return res.status(401).json({ error: "Not logged in" });
  res.json({ member: publicMember(member) });
});

/* ---------- Lightweight directory (any logged-in user, name-only) ---------- */
app.get("/api/team-lite", requireAuth, (req, res) => {
  res.json(store.members.map(m => ({ id: m.id, name: m.name })));
});

/* ---------- Members (admin only) ---------- */
app.get("/api/members", requireAdmin, (req, res) => {
  res.json(store.members.map(publicMember));
});

app.post("/api/members", requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  const pin = String(req.body.pin || "").trim();
  const role = req.body.role === "admin" ? "admin" : "member";
  if (!name) return res.status(400).json({ error: "Name is required" });
  if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: "PIN must be 4-6 digits" });
  if (store.members.some(m => m.name.toLowerCase() === name.toLowerCase())) {
    return res.status(409).json({ error: "That name is already in use" });
  }
  const member = { id: uid(), name, pinHash: bcrypt.hashSync(pin, 10), role, createdAt: Date.now() };
  store.members.push(member);
  await save();
  res.status(201).json(publicMember(member));
});

app.patch("/api/members/:id", requireAdmin, async (req, res) => {
  const member = store.members.find(m => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: "Not found" });

  if (req.body.name !== undefined) {
    const name = String(req.body.name).trim();
    if (!name) return res.status(400).json({ error: "Name cannot be empty" });
    if (store.members.some(m => m.id !== member.id && m.name.toLowerCase() === name.toLowerCase())) {
      return res.status(409).json({ error: "That name is already in use" });
    }
    member.name = name;
  }
  if (req.body.pin !== undefined) {
    const pin = String(req.body.pin).trim();
    if (!/^\d{4,6}$/.test(pin)) return res.status(400).json({ error: "PIN must be 4-6 digits" });
    member.pinHash = bcrypt.hashSync(pin, 10);
  }
  if (req.body.role !== undefined) {
    const nextRole = req.body.role === "admin" ? "admin" : "member";
    if (member.role === "admin" && nextRole !== "admin") {
      const otherAdmins = store.members.filter(m => m.role === "admin" && m.id !== member.id);
      if (otherAdmins.length === 0) return res.status(400).json({ error: "At least one admin must remain" });
    }
    member.role = nextRole;
  }
  await save();
  res.json(publicMember(member));
});

app.delete("/api/members/:id", requireAdmin, async (req, res) => {
  const member = store.members.find(m => m.id === req.params.id);
  if (!member) return res.status(404).json({ error: "Not found" });
  if (member.role === "admin") {
    const otherAdmins = store.members.filter(m => m.role === "admin" && m.id !== member.id);
    if (otherAdmins.length === 0) return res.status(400).json({ error: "At least one admin must remain" });
  }
  store.members = store.members.filter(m => m.id !== member.id);
  store.projects.forEach(p => { p.memberIds = p.memberIds.filter(id => id !== member.id); });
  store.tasks.forEach(t => { if (t.assigneeId === member.id) t.assigneeId = null; });
  await save();
  res.json({ ok: true });
});

/* ---------- Projects ---------- */
app.get("/api/projects", requireAuth, (req, res) => {
  const list = req.member.role === "admin"
    ? store.projects
    : store.projects.filter(p => projectVisible(p, req.member));
  res.json(list);
});

app.post("/api/projects", requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Project name is required" });
  const project = {
    id: uid(),
    name,
    desc: String(req.body.desc || "").trim(),
    deadline: String(req.body.deadline || ""),
    memberIds: [],
    createdAt: Date.now()
  };
  store.projects.push(project);
  const group = { id: uid(), projectId: project.id, name: "Tasks", createdAt: Date.now() };
  store.groups.push(group);
  await save();
  res.status(201).json(project);
});

app.patch("/api/projects/:id", requireAdmin, async (req, res) => {
  const project = store.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  if (req.body.name !== undefined) project.name = String(req.body.name).trim() || project.name;
  if (req.body.desc !== undefined) project.desc = String(req.body.desc).trim();
  if (req.body.deadline !== undefined) project.deadline = String(req.body.deadline);
  if (req.body.memberIds !== undefined && Array.isArray(req.body.memberIds)) {
    const validIds = new Set(store.members.map(m => m.id));
    project.memberIds = req.body.memberIds.filter(id => validIds.has(id));
  }
  await save();
  res.json(project);
});

app.delete("/api/projects/:id", requireAdmin, async (req, res) => {
  const project = store.projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: "Not found" });
  store.projects = store.projects.filter(p => p.id !== project.id);
  store.groups = store.groups.filter(g => g.projectId !== project.id);
  store.tasks = store.tasks.filter(t => t.projectId !== project.id);
  await save();
  res.json({ ok: true });
});

/* ---------- Groups ---------- */
function loadProjectOr403(req, res) {
  const projectId = req.query.projectId || req.body.projectId;
  const project = store.projects.find(p => p.id === projectId);
  if (!project) { res.status(404).json({ error: "Project not found" }); return null; }
  if (!projectVisible(project, req.member)) { res.status(403).json({ error: "Not assigned to this project" }); return null; }
  return project;
}

app.get("/api/groups", requireAuth, (req, res) => {
  const project = loadProjectOr403(req, res);
  if (!project) return;
  res.json(store.groups.filter(g => g.projectId === project.id));
});

app.post("/api/groups", requireAdmin, async (req, res) => {
  const project = store.projects.find(p => p.id === req.body.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Group name is required" });
  const group = { id: uid(), projectId: project.id, name, createdAt: Date.now() };
  store.groups.push(group);
  await save();
  res.status(201).json(group);
});

app.patch("/api/groups/:id", requireAdmin, async (req, res) => {
  const group = store.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: "Not found" });
  if (req.body.name !== undefined) group.name = String(req.body.name).trim() || group.name;
  await save();
  res.json(group);
});

app.delete("/api/groups/:id", requireAdmin, async (req, res) => {
  const group = store.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: "Not found" });
  const idsInGroup = store.tasks.filter(t => t.groupId === group.id).map(t => t.id);
  store.tasks = store.tasks.filter(t => t.groupId !== group.id && !idsInGroup.includes(t.parentId));
  store.groups = store.groups.filter(g => g.id !== group.id);
  await save();
  res.json({ ok: true });
});

/* ---------- Tasks ---------- */
app.get("/api/tasks", requireAuth, (req, res) => {
  if (!req.query.projectId) {
    const visibleIds = new Set(
      store.projects.filter(p => projectVisible(p, req.member)).map(p => p.id)
    );
    return res.json(store.tasks.filter(t => visibleIds.has(t.projectId)));
  }
  const project = loadProjectOr403(req, res);
  if (!project) return;
  res.json(store.tasks.filter(t => t.projectId === project.id));
});

app.post("/api/tasks", requireAdmin, async (req, res) => {
  const project = store.projects.find(p => p.id === req.body.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const group = store.groups.find(g => g.id === req.body.groupId && g.projectId === project.id);
  if (!group) return res.status(404).json({ error: "Group not found" });
  const title = String(req.body.title || "").trim();
  if (!title) return res.status(400).json({ error: "Task title is required" });

  let parentId = null;
  if (req.body.parentId) {
    const parent = store.tasks.find(t => t.id === req.body.parentId && t.groupId === group.id);
    if (!parent) return res.status(404).json({ error: "Parent task not found" });
    parentId = parent.id;
  }

  const task = {
    id: uid(),
    projectId: project.id,
    groupId: group.id,
    parentId,
    title,
    assigneeId: null,
    status: store.statuses[0].id,
    dueDate: "",
    start: "",
    end: "",
    createdAt: Date.now()
  };
  store.tasks.push(task);
  await save();
  res.status(201).json(task);
});

app.patch("/api/tasks/:id", requireAuth, async (req, res) => {
  const task = store.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  const project = store.projects.find(p => p.id === task.projectId);
  if (!project || !projectVisible(project, req.member)) return res.status(403).json({ error: "Not assigned to this project" });

  if (req.member.role === "admin") {
    const fields = ["title", "assigneeId", "status", "dueDate", "start", "end"];
    fields.forEach(f => {
      if (req.body[f] !== undefined) task[f] = req.body[f];
    });
  } else {
    const keys = Object.keys(req.body);
    if (keys.length !== 1 || keys[0] !== "status") {
      return res.status(403).json({ error: "You can only change the status of your own tasks" });
    }
    if (task.assigneeId !== req.member.id) {
      return res.status(403).json({ error: "This task is not assigned to you" });
    }
    if (!store.statuses.some(s => s.id === req.body.status)) {
      return res.status(400).json({ error: "Unknown status" });
    }
    task.status = req.body.status;
  }

  await save();
  res.json(task);
});

app.delete("/api/tasks/:id", requireAdmin, async (req, res) => {
  const task = store.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  store.tasks = store.tasks.filter(t => t.id !== task.id && t.parentId !== task.id);
  await save();
  res.json({ ok: true });
});

/* ---------- Statuses ---------- */
app.get("/api/statuses", requireAuth, (req, res) => {
  res.json(store.statuses);
});

app.post("/api/statuses", requireAdmin, async (req, res) => {
  const label = String(req.body.label || "New Status").trim();
  const color = String(req.body.color || "#579bfc");
  const status = { id: uid(), label, color };
  store.statuses.push(status);
  await save();
  res.status(201).json(status);
});

app.patch("/api/statuses/:id", requireAdmin, async (req, res) => {
  const status = store.statuses.find(s => s.id === req.params.id);
  if (!status) return res.status(404).json({ error: "Not found" });
  if (req.body.label !== undefined) status.label = String(req.body.label).trim() || status.label;
  if (req.body.color !== undefined) status.color = String(req.body.color);
  await save();
  res.json(status);
});

app.delete("/api/statuses/:id", requireAdmin, async (req, res) => {
  if (store.statuses.length <= 1) return res.status(400).json({ error: "At least one status must remain" });
  store.statuses = store.statuses.filter(s => s.id !== req.params.id);
  await save();
  res.json({ ok: true });
});

/* ---------- Backup / restore (admin only) ---------- */
app.get("/api/backup", requireAdmin, (req, res) => {
  const filename = `workflow-backup-${new Date().toISOString().slice(0, 10)}.json`;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(JSON.stringify(store, null, 2));
});

app.post("/api/restore", requireAdmin, async (req, res) => {
  const incoming = req.body;
  const requiredArrays = ["members", "projects", "groups", "tasks", "statuses"];
  const isValid = incoming && typeof incoming === "object" &&
    requiredArrays.every(key => Array.isArray(incoming[key]));
  if (!isValid) {
    return res.status(400).json({ error: "That file doesn't look like a valid WorkFlow backup" });
  }
  if (incoming.statuses.length === 0) {
    return res.status(400).json({ error: "Backup must include at least one status" });
  }
  if (!incoming.members.some(m => m.role === "admin")) {
    return res.status(400).json({ error: "Backup must include at least one admin account" });
  }

  store.members = incoming.members;
  store.projects = incoming.projects;
  store.groups = incoming.groups;
  store.tasks = incoming.tasks;
  store.statuses = incoming.statuses;
  await save();
  res.json({ ok: true });
});

/* ---------- Static frontend ---------- */
app.use(express.static(path.join(__dirname, "public")));

app.listen(PORT, () => {
  console.log(`WorkFlow server running at http://localhost:${PORT}`);
});
