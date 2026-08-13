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

function uid() {
  return crypto.randomUUID();
}

function emptyStore() {
  return { members: [], projects: [], groups: [], tasks: [], statuses: DEFAULT_STATUSES.map(s => ({ ...s })) };
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
  if (!store.statuses || store.statuses.length === 0) store.statuses = DEFAULT_STATUSES.map(s => ({ ...s }));
  if (!store.members) store.members = [];
  if (!store.projects) store.projects = [];
  if (!store.tasks) store.tasks = [];
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

module.exports = { store, save, uid };
