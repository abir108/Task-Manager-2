const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { store, save, uid, recomputeProjectCategory, DEFAULT_STATUSES, PROJECT_CATEGORIES } = require("./db");

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
  return { id: m.id, name: m.name, role: m.role, avatarUrl: m.avatarUrl || null, createdAt: m.createdAt };
}

const MAX_AVATAR_LENGTH = 400000; // ~290KB decoded, generous for a small profile photo

function isValidAvatarUrl(v) {
  return typeof v === "string" && v.startsWith("data:image/") && v.length <= MAX_AVATAR_LENGTH;
}

function projectVisible(project, member) {
  if (member.role === "admin") return true;
  return project.memberIds.includes(member.id);
}

const MAX_INSTRUCTIONS_LENGTH = 20000;

// Light defense-in-depth strip on top of the client-side DOM-based sanitizer:
// removes script/style/iframe/object/embed blocks and any on*="" event handler attributes.
function sanitizeInstructionsHtml(html) {
  return String(html)
    .slice(0, MAX_INSTRUCTIONS_LENGTH)
    .replace(/<(script|style|iframe|object|embed)[\s\S]*?<\/\1>/gi, "")
    .replace(/<(script|style|iframe|object|embed)[^>]*\/?>/gi, "")
    .replace(/\son\w+\s*=\s*(".*?"|'.*?'|[^\s>]+)/gi, "")
    .replace(/javascript:/gi, "");
}

/* ---------- Note attachments ---------- */
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const NOTES_DIR = path.join(UPLOAD_DIR, "notes");
if (!fs.existsSync(NOTES_DIR)) fs.mkdirSync(NOTES_DIR, { recursive: true });

const ALLOWED_ATTACHMENT_EXT = new Set([
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt",
  ".png", ".jpg", ".jpeg", ".gif"
]);
const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_ATTACHMENTS_PER_NOTE = 5;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_SIZE, files: MAX_ATTACHMENTS_PER_NOTE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if (!ALLOWED_ATTACHMENT_EXT.has(ext)) return cb(new Error("That file type isn't allowed"));
    cb(null, true);
  }
});

function taskAccessOr403(req, res, taskId) {
  const task = store.tasks.find(t => t.id === taskId);
  if (!task) { res.status(404).json({ error: "Task not found" }); return null; }
  const project = store.projects.find(p => p.id === task.projectId);
  if (!project || !projectVisible(project, req.member)) { res.status(403).json({ error: "Not assigned to this project" }); return null; }
  return task;
}

function deleteNotesForTaskIds(taskIds) {
  if (!taskIds.length) return;
  const idSet = new Set(taskIds);
  const toRemove = store.notes.filter(n => idSet.has(n.taskId));
  store.notes = store.notes.filter(n => !idSet.has(n.taskId));
  toRemove.forEach(note => {
    const noteDir = path.join(NOTES_DIR, note.id);
    if (fs.existsSync(noteDir)) fs.rmSync(noteDir, { recursive: true, force: true });
  });
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
  res.json(store.members.map(m => ({ id: m.id, name: m.name, avatarUrl: m.avatarUrl || null })));
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
  let avatarUrl = null;
  if (req.body.avatarUrl) {
    if (!isValidAvatarUrl(req.body.avatarUrl)) return res.status(400).json({ error: "Invalid or too large profile picture" });
    avatarUrl = req.body.avatarUrl;
  }
  const member = { id: uid(), name, pinHash: bcrypt.hashSync(pin, 10), role, avatarUrl, createdAt: Date.now() };
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
  if (req.body.avatarUrl !== undefined) {
    if (req.body.avatarUrl === null || req.body.avatarUrl === "") {
      member.avatarUrl = null;
    } else if (isValidAvatarUrl(req.body.avatarUrl)) {
      member.avatarUrl = req.body.avatarUrl;
    } else {
      return res.status(400).json({ error: "Invalid or too large profile picture" });
    }
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
  store.tasks.forEach(t => { t.assigneeIds = (t.assigneeIds || []).filter(id => id !== member.id); });
  await save();
  res.json({ ok: true });
});

/* ---------- Sidebar category labels ---------- */
app.get("/api/category-labels", requireAuth, (req, res) => {
  res.json(store.categoryLabels);
});

app.patch("/api/category-labels", requireAdmin, async (req, res) => {
  PROJECT_CATEGORIES.forEach(key => {
    if (req.body[key] !== undefined) {
      const v = String(req.body[key]).trim();
      if (v) store.categoryLabels[key] = v;
    }
  });
  await save();
  res.json(store.categoryLabels);
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
    category: "running",
    folderId: null,
    instructions: "",
    createdAt: Date.now()
  };
  store.projects.push(project);
  const group = { id: uid(), projectId: project.id, name: "Tasks", statuses: DEFAULT_STATUSES.map(s => ({ ...s })), order: 0, createdAt: Date.now() };
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
  if (req.body.category !== undefined && PROJECT_CATEGORIES.includes(req.body.category)) {
    project.category = req.body.category;
  }
  if (req.body.folderId !== undefined) {
    if (req.body.folderId === null) {
      project.folderId = null;
    } else if (store.folders.some(f => f.id === req.body.folderId)) {
      project.folderId = req.body.folderId;
    } else {
      return res.status(400).json({ error: "Unknown folder" });
    }
  }
  if (req.body.instructions !== undefined) {
    project.instructions = sanitizeInstructionsHtml(req.body.instructions);
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

/* ---------- Custom folders (sit alongside the fixed categories) ---------- */
app.get("/api/folders", requireAuth, (req, res) => {
  res.json(store.folders);
});

app.post("/api/folders", requireAdmin, async (req, res) => {
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Folder name is required" });
  const folder = { id: uid(), name, createdAt: Date.now() };
  store.folders.push(folder);
  await save();
  res.status(201).json(folder);
});

app.patch("/api/folders/:id", requireAdmin, async (req, res) => {
  const folder = store.folders.find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: "Not found" });
  if (req.body.name !== undefined) folder.name = String(req.body.name).trim() || folder.name;
  await save();
  res.json(folder);
});

app.delete("/api/folders/:id", requireAdmin, async (req, res) => {
  const folder = store.folders.find(f => f.id === req.params.id);
  if (!folder) return res.status(404).json({ error: "Not found" });
  store.folders = store.folders.filter(f => f.id !== folder.id);
  store.projects.forEach(p => { if (p.folderId === folder.id) p.folderId = null; });
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

const byGroupOrder = (a, b) => (a.order || 0) - (b.order || 0);

app.get("/api/groups", requireAuth, (req, res) => {
  const project = loadProjectOr403(req, res);
  if (!project) return;
  res.json(store.groups.filter(g => g.projectId === project.id).sort(byGroupOrder));
});

app.post("/api/groups", requireAdmin, async (req, res) => {
  const project = store.projects.find(p => p.id === req.body.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });
  const name = String(req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Group name is required" });
  const siblingCount = store.groups.filter(g => g.projectId === project.id).length;
  const group = { id: uid(), projectId: project.id, name, statuses: DEFAULT_STATUSES.map(s => ({ ...s })), order: siblingCount, createdAt: Date.now() };
  store.groups.push(group);
  await save();
  res.status(201).json(group);
});

app.post("/api/groups/reorder", requireAdmin, async (req, res) => {
  const groupIds = req.body.groupIds;
  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    return res.status(400).json({ error: "groupIds must be a non-empty array" });
  }
  const involved = groupIds.map(id => store.groups.find(g => g.id === id));
  if (involved.some(g => !g)) return res.status(404).json({ error: "One or more groups not found" });
  const { projectId } = involved[0];
  if (!involved.every(g => g.projectId === projectId)) {
    return res.status(400).json({ error: "All groups must belong to the same project" });
  }
  groupIds.forEach((id, index) => {
    store.groups.find(g => g.id === id).order = index;
  });
  await save();
  res.json({ ok: true });
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

app.post("/api/groups/:id/duplicate", requireAdmin, async (req, res) => {
  const group = store.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: "Not found" });

  const newGroup = {
    id: uid(),
    projectId: group.projectId,
    name: group.name + " (Copy)",
    statuses: (group.statuses || DEFAULT_STATUSES).map(s => ({ ...s })),
    order: (group.order || 0) + 0.5,
    createdAt: Date.now()
  };
  const originalTasks = store.tasks.filter(t => t.groupId === group.id);
  const idMap = new Map();
  originalTasks.forEach(t => idMap.set(t.id, uid()));
  const newTasks = originalTasks.map(t => ({
    ...t,
    id: idMap.get(t.id),
    groupId: newGroup.id,
    parentId: t.parentId ? idMap.get(t.parentId) : null
  }));

  const groupIndex = store.groups.findIndex(g => g.id === group.id);
  store.groups.splice(groupIndex + 1, 0, newGroup);
  store.tasks.push(...newTasks);
  await save();
  res.status(201).json({ group: newGroup, tasks: newTasks });
});

app.post("/api/groups/:id/send-query", requireAdmin, async (req, res) => {
  const group = store.groups.find(g => g.id === req.params.id);
  if (!group) return res.status(404).json({ error: "Not found" });
  const project = store.projects.find(p => p.id === group.projectId);
  if (!project) return res.status(404).json({ error: "Project not found" });

  const topCount = store.tasks.filter(t => t.groupId === group.id && !t.parentId).length;
  const task = {
    id: uid(),
    projectId: project.id,
    groupId: group.id,
    parentId: null,
    title: "Send Query",
    assigneeIds: [],
    status: group.statuses[0].id,
    dueDate: "",
    start: "",
    end: "",
    completedAt: null,
    isQueryTrigger: true,
    order: topCount,
    createdAt: Date.now()
  };
  store.tasks.push(task);
  await save();
  res.status(201).json({ task, project });
});

/* ---------- Tasks ---------- */
const byOrder = (a, b) => (a.order || 0) - (b.order || 0);

app.get("/api/tasks", requireAuth, (req, res) => {
  if (!req.query.projectId) {
    const visibleIds = new Set(
      store.projects.filter(p => projectVisible(p, req.member)).map(p => p.id)
    );
    return res.json(store.tasks.filter(t => visibleIds.has(t.projectId)).sort(byOrder));
  }
  const project = loadProjectOr403(req, res);
  if (!project) return;
  res.json(store.tasks.filter(t => t.projectId === project.id).sort(byOrder));
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

  let status = group.statuses[0].id;
  if (req.body.status !== undefined && group.statuses.some(s => s.id === req.body.status)) {
    status = req.body.status;
  }

  const siblingCount = store.tasks.filter(t => t.groupId === group.id && t.parentId === parentId).length;
  const task = {
    id: uid(),
    projectId: project.id,
    groupId: group.id,
    parentId,
    title,
    assigneeIds: [],
    status,
    dueDate: "",
    start: "",
    end: "",
    completedAt: null,
    order: siblingCount,
    createdAt: Date.now()
  };
  store.tasks.push(task);
  await save();
  res.status(201).json(task);
});

app.post("/api/tasks/reorder", requireAdmin, async (req, res) => {
  const taskIds = req.body.taskIds;
  if (!Array.isArray(taskIds) || taskIds.length === 0) {
    return res.status(400).json({ error: "taskIds must be a non-empty array" });
  }
  const involved = taskIds.map(id => store.tasks.find(t => t.id === id));
  if (involved.some(t => !t)) return res.status(404).json({ error: "One or more tasks not found" });
  const { groupId, parentId } = involved[0];
  if (!involved.every(t => t.groupId === groupId && t.parentId === parentId)) {
    return res.status(400).json({ error: "All tasks must be siblings in the same group" });
  }
  taskIds.forEach((id, index) => {
    store.tasks.find(t => t.id === id).order = index;
  });
  await save();
  res.json({ ok: true });
});

app.patch("/api/tasks/:id", requireAuth, async (req, res) => {
  const task = store.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  const project = store.projects.find(p => p.id === task.projectId);
  if (!project || !projectVisible(project, req.member)) return res.status(403).json({ error: "Not assigned to this project" });
  const group = store.groups.find(g => g.id === task.groupId);

  let statusChanged = false;

  if (req.member.role === "admin") {
    if (req.body.title !== undefined) task.title = String(req.body.title);
    if (req.body.dueDate !== undefined) task.dueDate = String(req.body.dueDate);
    if (req.body.start !== undefined) task.start = String(req.body.start);
    if (req.body.end !== undefined) task.end = String(req.body.end);
    if (req.body.assigneeIds !== undefined && Array.isArray(req.body.assigneeIds)) {
      const validIds = new Set(store.members.map(m => m.id));
      task.assigneeIds = req.body.assigneeIds.filter(id => validIds.has(id));
    }
    if (req.body.status !== undefined) {
      if (!group || !group.statuses.some(s => s.id === req.body.status)) {
        return res.status(400).json({ error: "Unknown status" });
      }
      task.status = req.body.status;
      statusChanged = true;
    }
  } else {
    const keys = Object.keys(req.body);
    if (keys.length !== 1 || keys[0] !== "status") {
      return res.status(403).json({ error: "You can only change the status of your own tasks" });
    }
    if (!(task.assigneeIds || []).includes(req.member.id)) {
      return res.status(403).json({ error: "This task is not assigned to you" });
    }
    if (!group || !group.statuses.some(s => s.id === req.body.status)) {
      return res.status(400).json({ error: "Unknown status" });
    }
    task.status = req.body.status;
    statusChanged = true;
  }

  if (statusChanged) {
    task.completedAt = task.status === "done" ? Date.now() : null;
    if (task.isQueryTrigger && task.status === "done") {
      project.category = "query";
    }
    recomputeProjectCategory(task.projectId);
  }

  await save();
  res.json(task);
});

app.delete("/api/tasks/:id", requireAdmin, async (req, res) => {
  const task = store.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: "Not found" });
  const removedIds = store.tasks.filter(t => t.id === task.id || t.parentId === task.id).map(t => t.id);
  store.tasks = store.tasks.filter(t => t.id !== task.id && t.parentId !== task.id);
  deleteNotesForTaskIds(removedIds);
  await save();
  res.json({ ok: true });
});

/* ---------- Task notes / updates (with file attachments) ---------- */
app.get("/api/notes", requireAuth, (req, res) => {
  const project = loadProjectOr403(req, res);
  if (!project) return;
  const taskIds = new Set(store.tasks.filter(t => t.projectId === project.id).map(t => t.id));
  const notes = store.notes.filter(n => taskIds.has(n.taskId)).sort((a, b) => a.createdAt - b.createdAt);
  res.json(notes);
});

app.post("/api/tasks/:id/notes", requireAuth, upload.array("attachments", MAX_ATTACHMENTS_PER_NOTE), async (req, res) => {
  const task = taskAccessOr403(req, res, req.params.id);
  if (!task) return;

  const text = String(req.body.text || "").trim();
  const files = req.files || [];
  if (!text && files.length === 0) return res.status(400).json({ error: "Write something or attach a file" });

  const noteId = uid();
  const attachments = [];
  if (files.length) {
    const noteDir = path.join(NOTES_DIR, noteId);
    fs.mkdirSync(noteDir, { recursive: true });
    files.forEach(file => {
      const attId = uid();
      const ext = path.extname(file.originalname).toLowerCase();
      const storedName = attId + ext;
      fs.writeFileSync(path.join(noteDir, storedName), file.buffer);
      attachments.push({ id: attId, originalName: file.originalname, storedName, size: file.size, mimeType: file.mimetype });
    });
  }

  const note = {
    id: noteId,
    taskId: task.id,
    authorId: req.member.id,
    text,
    attachments,
    createdAt: Date.now()
  };
  store.notes.push(note);
  await save();
  res.status(201).json(note);
});

app.delete("/api/notes/:id", requireAuth, async (req, res) => {
  const note = store.notes.find(n => n.id === req.params.id);
  if (!note) return res.status(404).json({ error: "Not found" });
  const task = store.tasks.find(t => t.id === note.taskId);
  const project = task ? store.projects.find(p => p.id === task.projectId) : null;
  if (!project || !projectVisible(project, req.member)) return res.status(403).json({ error: "Not assigned to this project" });
  if (req.member.role !== "admin" && note.authorId !== req.member.id) {
    return res.status(403).json({ error: "You can only delete your own updates" });
  }
  store.notes = store.notes.filter(n => n.id !== note.id);
  const noteDir = path.join(NOTES_DIR, note.id);
  if (fs.existsSync(noteDir)) fs.rmSync(noteDir, { recursive: true, force: true });
  await save();
  res.json({ ok: true });
});

app.get("/api/notes/:noteId/attachments/:attId", requireAuth, (req, res) => {
  const note = store.notes.find(n => n.id === req.params.noteId);
  if (!note) return res.status(404).json({ error: "Not found" });
  const task = store.tasks.find(t => t.id === note.taskId);
  const project = task ? store.projects.find(p => p.id === task.projectId) : null;
  if (!project || !projectVisible(project, req.member)) return res.status(403).json({ error: "Not assigned to this project" });
  const att = note.attachments.find(a => a.id === req.params.attId);
  if (!att) return res.status(404).json({ error: "Not found" });
  const filePath = path.join(NOTES_DIR, note.id, att.storedName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: "File missing" });
  res.download(filePath, att.originalName);
});

/* ---------- Statuses (per group) ---------- */
function loadGroupOr403(req, res) {
  const group = store.groups.find(g => g.id === req.params.groupId);
  if (!group) { res.status(404).json({ error: "Group not found" }); return null; }
  const project = store.projects.find(p => p.id === group.projectId);
  if (!project || !projectVisible(project, req.member)) { res.status(403).json({ error: "Not assigned to this project" }); return null; }
  return group;
}

app.post("/api/groups/:groupId/statuses", requireAdmin, async (req, res) => {
  const group = loadGroupOr403(req, res);
  if (!group) return;
  const label = String(req.body.label || "New Status").trim();
  const color = String(req.body.color || "#579bfc");
  const status = { id: uid(), label, color };
  group.statuses.push(status);
  await save();
  res.status(201).json(status);
});

app.patch("/api/groups/:groupId/statuses/:id", requireAdmin, async (req, res) => {
  const group = loadGroupOr403(req, res);
  if (!group) return;
  const status = group.statuses.find(s => s.id === req.params.id);
  if (!status) return res.status(404).json({ error: "Not found" });
  if (req.body.label !== undefined) status.label = String(req.body.label).trim() || status.label;
  if (req.body.color !== undefined) status.color = String(req.body.color);
  await save();
  res.json(status);
});

app.delete("/api/groups/:groupId/statuses/:id", requireAdmin, async (req, res) => {
  const group = loadGroupOr403(req, res);
  if (!group) return;
  if (group.statuses.length <= 1) return res.status(400).json({ error: "At least one status must remain" });
  group.statuses = group.statuses.filter(s => s.id !== req.params.id);
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
  const requiredArrays = ["members", "projects", "groups", "tasks"];
  const isValid = incoming && typeof incoming === "object" &&
    requiredArrays.every(key => Array.isArray(incoming[key]));
  if (!isValid) {
    return res.status(400).json({ error: "That file doesn't look like a valid backup" });
  }
  if (!incoming.members.some(m => m.role === "admin")) {
    return res.status(400).json({ error: "Backup must include at least one admin account" });
  }

  incoming.projects.forEach(p => {
    if (!p.category || !PROJECT_CATEGORIES.includes(p.category)) p.category = "running";
    if (p.folderId === undefined) p.folderId = null;
    if (p.instructions === undefined) p.instructions = "";
  });
  incoming.tasks.forEach(t => {
    if (!Array.isArray(t.assigneeIds)) t.assigneeIds = t.assigneeId ? [t.assigneeId] : [];
  });
  // Older backups had a single global status list; migrate it onto each group.
  const legacyStatuses = (Array.isArray(incoming.statuses) && incoming.statuses.length) ? incoming.statuses : DEFAULT_STATUSES;
  const restoreGroupOrderCounters = new Map();
  incoming.groups.forEach(g => {
    if (!Array.isArray(g.statuses) || g.statuses.length === 0) {
      g.statuses = legacyStatuses.map(s => ({ ...s }));
    }
    if (g.order === undefined) {
      const next = restoreGroupOrderCounters.get(g.projectId) || 0;
      g.order = next;
      restoreGroupOrderCounters.set(g.projectId, next + 1);
    }
  });

  store.members = incoming.members;
  store.projects = incoming.projects;
  store.groups = incoming.groups;
  store.tasks = incoming.tasks;
  store.notes = Array.isArray(incoming.notes) ? incoming.notes : [];
  store.folders = Array.isArray(incoming.folders) ? incoming.folders : [];
  delete store.statuses;
  if (incoming.categoryLabels && typeof incoming.categoryLabels === "object") {
    store.categoryLabels = incoming.categoryLabels;
  }
  await save();
  res.json({ ok: true });
});

/* ---------- Static frontend ---------- */
app.use(express.static(path.join(__dirname, "public")));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") return res.status(400).json({ error: "File is too large (max 10MB each)" });
    if (err.code === "LIMIT_FILE_COUNT") return res.status(400).json({ error: `You can attach at most ${MAX_ATTACHMENTS_PER_NOTE} files` });
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message || "Request failed" });
  next();
});

app.listen(PORT, () => {
  console.log(`WorkFlow server running at http://localhost:${PORT}`);
});
