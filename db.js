const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "store.json");

const DEFAULT_STATUSES = [
  { id: "not_started", label: "Not Started", color: "#c4c4c4" },
  { id: "working",     label: "Working on it", color: "#fdab3d" },
  { id: "stuck",       label: "Stuck", color: "#e2445c" },
  { id: "done",        label: "Done", color: "#00c875" }
];

const DEFAULT_CATEGORY_LABELS = {
  running: "Running Projects",
  query: "Sent to Query",
  completed: "Completed Projects"
};

function uid() {
  return crypto.randomUUID();
}

function emptyStore() {
  return {
    members: [],
    projects: [],
    groups: [],
    tasks: [],
    categoryLabels: { ...DEFAULT_CATEGORY_LABELS }
  };
}

function load() {
  if (!fs.existsSync(DATA_FILE)) {
    const store = emptyStore();
    const adminPin = "1234";
    store.members.push({
      id: uid(),
      name: "Admin",
      pinHash: bcrypt.hashSync(adminPin, 10),
      role: "admin",
      createdAt: Date.now()
    });
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
    console.log(`\nFirst run: created default admin login -> name "Admin", PIN "${adminPin}".`);
    console.log("Log in and change this PIN immediately from the Team page.\n");
    return store;
  }
  const raw = fs.readFileSync(DATA_FILE, "utf8");
  const store = JSON.parse(raw);
  if (!store.groups) store.groups = [];
  if (!store.members) store.members = [];
  if (!store.projects) store.projects = [];
  if (!store.tasks) store.tasks = [];
  if (!store.categoryLabels) store.categoryLabels = { ...DEFAULT_CATEGORY_LABELS };
  ["running", "query", "completed"].forEach(key => {
    if (!store.categoryLabels[key]) store.categoryLabels[key] = DEFAULT_CATEGORY_LABELS[key];
  });

  let changed = false;
  store.projects.forEach(p => {
    if (!p.category || !["running", "query", "completed"].includes(p.category)) {
      p.category = "running";
      changed = true;
    }
  });
  // Statuses used to be global (store.statuses); now each group owns its own list.
  const legacyStatuses = (store.statuses && store.statuses.length) ? store.statuses : DEFAULT_STATUSES;
  store.groups.forEach(g => {
    if (!Array.isArray(g.statuses) || g.statuses.length === 0) {
      g.statuses = legacyStatuses.map(s => ({ ...s }));
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
  if (changed) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
  }
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

/* Recompute a project's category based on its tasks' completion state.
   All tasks (including subitems) done -> "completed".
   If it was auto-completed but no longer all-done -> back to "running".
   Manual "query" state is left alone unless the project just became fully done. */
function recomputeProjectCategory(projectId) {
  const project = store.projects.find(p => p.id === projectId);
  if (!project) return;
  const tasks = store.tasks.filter(t => t.projectId === projectId);
  if (tasks.length === 0) return;
  const allDone = tasks.every(t => t.status === "done");
  if (allDone) {
    project.category = "completed";
  } else if (project.category === "completed") {
    project.category = "running";
  }
}

module.exports = { store, save, uid, recomputeProjectCategory, DEFAULT_CATEGORY_LABELS, DEFAULT_STATUSES };
