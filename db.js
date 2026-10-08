const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");
const MEMBERS_FILE = path.join(DATA_DIR, "members.json");

const DEFAULT_STATUSES = [
  { id: "not_started", label: "Not Started", color: "#c4c4c4" },
  { id: "working",     label: "Working on it", color: "#fdab3d" },
  { id: "stuck",       label: "Stuck", color: "#e2445c" },
  { id: "done",        label: "Done", color: "#00c875" }
];

const PROJECT_CATEGORIES = ["running", "query", "completed", "archived"];

const DEFAULT_CATEGORY_LABELS = {
  running: "Running Projects",
  query: "Sent to Query",
  completed: "Completed Projects",
  archived: "Archived"
};

const ADMIN_EMAIL = "cloudtechacademybd@gmail.com";
const ADMIN_PASSWORD = "Cloudtech2026";
// Earlier builds seeded this address; it is moved to ADMIN_EMAIL on load.
const OLD_BOOTSTRAP_EMAIL = "admin@cloudtechaccounting.com";

function uid() {
  return crypto.randomUUID();
}

function emptyStore() {
  return {
    members: [],
    projects: [],
    groups: [],
    tasks: [],
    notes: [],
    folders: [],
    categoryLabels: { ...DEFAULT_CATEGORY_LABELS }
  };
}

/* Login is email + password only. The original Admin (legacy PIN only, or
   seeded with the old bootstrap email) gets the real admin email and initial
   password once. If, after that, no admin could log in at all, the first admin
   gets them so the system can never be locked out. */
function normalizeMembers(members) {
  let changed = false;
  members.forEach(m => {
    if (m.email === undefined) { m.email = null; changed = true; }
    if (m.passwordHash === undefined) { m.passwordHash = null; changed = true; }
  });
  const grantAdminLogin = (m) => {
    m.email = ADMIN_EMAIL;
    m.passwordHash = bcrypt.hashSync(ADMIN_PASSWORD, 10);
    changed = true;
  };
  const bootstrapAdmin = members.find(m =>
    m.name === "Admin" && m.role === "admin" && (!m.email || m.email.toLowerCase() === OLD_BOOTSTRAP_EMAIL));
  if (bootstrapAdmin) grantAdminLogin(bootstrapAdmin);
  if (!members.some(m => m.role === "admin" && m.email && m.passwordHash)) {
    const firstAdmin = members.find(m => m.role === "admin");
    if (firstAdmin) grantAdminLogin(firstAdmin);
  }
  return changed;
}

function persistSync(s) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(s, null, 2));
}

function load() {
  const hasStore = fs.existsSync(DATA_FILE);
  const store = hasStore ? JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) : emptyStore();
  let changed = !hasStore;

  if (!Array.isArray(store.members)) store.members = [];
  // An interim build kept the team in a separate members.json; fold it back
  // into store.json (once) and set the old file aside.
  if (store.members.length === 0 && fs.existsSync(MEMBERS_FILE)) {
    const fromFile = JSON.parse(fs.readFileSync(MEMBERS_FILE, "utf8"));
    if (Array.isArray(fromFile) && fromFile.length > 0) {
      store.members = fromFile;
      changed = true;
    }
    fs.renameSync(MEMBERS_FILE, MEMBERS_FILE + ".old");
  }
  if (store.members.length === 0) {
    store.members.push({
      id: uid(),
      name: "Admin",
      email: ADMIN_EMAIL,
      passwordHash: bcrypt.hashSync(ADMIN_PASSWORD, 10),
      role: "admin",
      createdAt: Date.now()
    });
    changed = true;
    console.log(`\nNo team logins found: created default admin -> email "${ADMIN_EMAIL}", password "${ADMIN_PASSWORD}".`);
    console.log("Log in and change this password immediately from Edit Profile.\n");
  }

  if (!store.groups) store.groups = [];
  if (!store.projects) store.projects = [];
  if (!store.tasks) store.tasks = [];
  if (!store.notes) store.notes = [];
  if (!store.folders) store.folders = [];
  if (!store.categoryLabels) store.categoryLabels = { ...DEFAULT_CATEGORY_LABELS };
  PROJECT_CATEGORIES.forEach(key => {
    if (!store.categoryLabels[key]) store.categoryLabels[key] = DEFAULT_CATEGORY_LABELS[key];
  });

  if (normalizeMembers(store.members)) changed = true;
  store.projects.forEach(p => {
    if (!p.category || !PROJECT_CATEGORIES.includes(p.category)) {
      p.category = "running";
      changed = true;
    }
    if (p.folderId === undefined) { p.folderId = null; changed = true; }
    if (p.instructions === undefined) { p.instructions = ""; changed = true; }
  });
  // Statuses used to be global (store.statuses); now each group owns its own list.
  const legacyStatuses = (store.statuses && store.statuses.length) ? store.statuses : DEFAULT_STATUSES;
  const groupOrderCounters = new Map();
  store.groups.forEach(g => {
    if (!Array.isArray(g.statuses) || g.statuses.length === 0) {
      g.statuses = legacyStatuses.map(s => ({ ...s }));
      changed = true;
    }
    if (g.order === undefined) {
      const next = groupOrderCounters.get(g.projectId) || 0;
      g.order = next;
      groupOrderCounters.set(g.projectId, next + 1);
      changed = true;
    }
  });
  if (store.statuses) { delete store.statuses; changed = true; }
  const orderCounters = new Map();
  store.tasks.forEach(t => {
    if (!Array.isArray(t.assigneeIds)) {
      t.assigneeIds = t.assigneeId ? [t.assigneeId] : [];
      changed = true;
    }
    if (t.completedAt === undefined) {
      t.completedAt = t.status === "done" ? t.createdAt : null;
      changed = true;
    }
    if (t.order === undefined) {
      const key = t.groupId + "|" + (t.parentId || "");
      const next = orderCounters.get(key) || 0;
      t.order = next;
      orderCounters.set(key, next + 1);
      changed = true;
    }
  });
  // A task whose subtasks are all Done is itself Done; bring existing data in line.
  const touchedProjects = new Set();
  new Set(store.tasks.filter(t => t.parentId).map(t => t.parentId)).forEach(parentId => {
    const parent = store.tasks.find(t => t.id === parentId);
    const before = parent && parent.status;
    syncParentFromSubtasks(parentId, store);
    if (parent && parent.status !== before) touchedProjects.add(parent.projectId);
  });
  if (touchedProjects.size) {
    touchedProjects.forEach(pid => recomputeProjectCategory(pid, store));
    changed = true;
    console.log(`Marked parent tasks Done where all their subtasks were already Done (${touchedProjects.size} project(s) affected).`);
  }

  if (changed) persistSync(store);
  return store;
}

let store = load();
let writeChain = Promise.resolve();

function save() {
  writeChain = writeChain.then(() => new Promise((resolve, reject) => {
    fs.writeFile(DATA_FILE, JSON.stringify(store, null, 2), (err) => {
      if (err) reject(err); else resolve();
    });
  }));
  return writeChain;
}

/* When every subtask of a task is Done, the task itself becomes Done (finished
   when its last subtask was). If a subtask is reopened later, a task completed
   this way goes back to the status it had; a task someone set to Done by hand
   is left alone. `s` is the store to work on (defaults to the live one). */
function syncParentFromSubtasks(parentId, s = store) {
  const parent = s.tasks.find(t => t.id === parentId);
  if (!parent) return;
  const subs = s.tasks.filter(t => t.parentId === parentId);
  if (subs.length === 0) return;
  const group = s.groups.find(g => g.id === parent.groupId);
  const allDone = subs.every(t => t.status === "done");

  if (allDone && parent.status !== "done") {
    parent.autoDoneFrom = parent.status;
    parent.status = "done";
    parent.completedAt = Math.max(0, ...subs.map(t => t.completedAt || 0)) || Date.now();
    if (parent.isQueryTrigger) {
      const project = s.projects.find(p => p.id === parent.projectId);
      if (project) project.category = "query";
    }
  } else if (!allDone && parent.status === "done" && parent.autoDoneFrom) {
    const previous = group && group.statuses.some(st => st.id === parent.autoDoneFrom)
      ? parent.autoDoneFrom
      : (group ? group.statuses[0].id : parent.status);
    parent.status = previous;
    parent.completedAt = null;
    delete parent.autoDoneFrom;
  }
}

/* Recompute a project's category based on its tasks' completion state.
   All tasks (including subitems) done -> "completed".
   If it was auto-completed but no longer all-done -> back to "running".
   Manual "query" state is left alone unless the project just became fully done. */
function recomputeProjectCategory(projectId, s = store) {
  const project = s.projects.find(p => p.id === projectId);
  if (!project) return;
  if (project.category === "archived") return;
  const tasks = s.tasks.filter(t => t.projectId === projectId);
  if (tasks.length === 0) return;
  const allDone = tasks.every(t => t.status === "done");
  if (allDone) {
    project.category = "completed";
  } else if (project.category === "completed") {
    project.category = "running";
  }
}

module.exports = { store, save, uid, recomputeProjectCategory, syncParentFromSubtasks, normalizeMembers, DEFAULT_CATEGORY_LABELS, DEFAULT_STATUSES, PROJECT_CATEGORIES };
