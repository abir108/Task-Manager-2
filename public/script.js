/* ===========================================================
   WorkFlow — Project Dashboard (multi-user, server-backed)
=========================================================== */

const COLORS = ["#5b5ff0", "#ef6a6a", "#f2b94a", "#6fcf97", "#3ec6e0", "#c46be0", "#e08a3e", "#4fbf8b"];

let me = null;
let statuses = [];
let team = [];       // {id, name} lite directory, visible to everyone logged in
let members = [];    // full roster with roles, admin only
let projects = [];
let groups = [];
let tasks = [];
let currentBoardProjectId = null;
const collapsedTasks = new Set();

function isAdmin() { return !!me && me.role === "admin"; }

function initialsOf(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("");
}
function colorFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

/* ---------- API helper ---------- */
async function api(method, url, body) {
  const opts = { method, credentials: "same-origin", headers: {} };
  if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 401) {
    showLogin();
    throw new Error("Not logged in");
  }
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || "Request failed");
  return data;
}

/* ---------- Login / session ---------- */
function showLogin() {
  document.getElementById("login-screen").classList.remove("hidden");
  document.getElementById("app-shell").classList.add("hidden");
}
function showApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("app-shell").classList.remove("hidden");
}

document.getElementById("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("login-name").value.trim();
  const pin = document.getElementById("login-pin").value.trim();
  const errEl = document.getElementById("login-error");
  errEl.textContent = "";
  try {
    const data = await api("POST", "/api/login", { name, pin });
    me = data.member;
    await afterLogin();
  } catch (err) {
    errEl.textContent = err.message || "Login failed";
  }
});

document.getElementById("btn-logout").addEventListener("click", async () => {
  await api("POST", "/api/logout").catch(() => {});
  me = null; statuses = []; team = []; members = []; projects = []; groups = []; tasks = [];
  currentBoardProjectId = null;
  document.getElementById("login-name").value = "";
  document.getElementById("login-pin").value = "";
  document.body.classList.remove("role-member");
  showLogin();
});

async function afterLogin() {
  document.body.classList.toggle("role-member", !isAdmin());
  document.getElementById("current-user-name").textContent = me.name;
  document.getElementById("current-user-role").textContent = isAdmin() ? "Admin" : "Member";
  document.getElementById("projects-subtitle").textContent = isAdmin()
    ? "Create and manage your projects"
    : "Projects you've been assigned to";
  document.getElementById("stat-members-card").style.display = isAdmin() ? "" : "none";
  showApp();
  statuses = await api("GET", "/api/statuses");
  team = await api("GET", "/api/team-lite");
  await showView("dashboard");
}

async function tryResume() {
  try {
    const data = await api("GET", "/api/me");
    me = data.member;
    await afterLogin();
  } catch (e) {
    showLogin();
  }
}

/* ---------- Navigation ---------- */
const navButtons = document.querySelectorAll(".nav-btn");
navButtons.forEach(btn => {
  btn.addEventListener("click", () => showView(btn.dataset.view));
});

async function showView(name) {
  if (name === "team" && !isAdmin()) name = "dashboard";
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");
  navButtons.forEach(b => b.classList.toggle("active", b.dataset.view === name));
  if (name === "dashboard") await renderDashboard();
  if (name === "projects") await renderProjects();
  if (name === "team") await renderTeam();
}

document.getElementById("btn-back-projects").addEventListener("click", () => showView("projects"));

/* ---------- Modal helpers ---------- */
function openModal(id) { document.getElementById(id).classList.add("open"); }
function closeModal(id) { document.getElementById(id).classList.remove("open"); }

document.querySelectorAll("[data-close]").forEach(el => {
  el.addEventListener("click", () => closeModal(el.dataset.close));
});
document.querySelectorAll(".modal-overlay").forEach(overlay => {
  overlay.addEventListener("click", e => {
    if (e.target === overlay) overlay.classList.remove("open");
  });
});

/* ===========================================================
   PROJECTS
=========================================================== */

document.getElementById("btn-new-project").addEventListener("click", () => {
  document.getElementById("input-project-name").value = "";
  document.getElementById("input-project-desc").value = "";
  document.getElementById("input-project-deadline").value = "";
  document.getElementById("project-error").textContent = "";
  openModal("modal-project");
});

document.getElementById("btn-save-project").addEventListener("click", async () => {
  const errEl = document.getElementById("project-error");
  errEl.textContent = "";
  const name = document.getElementById("input-project-name").value.trim();
  if (!name) { errEl.textContent = "Please enter a project name."; return; }
  const desc = document.getElementById("input-project-desc").value.trim();
  const deadline = document.getElementById("input-project-deadline").value;
  try {
    await api("POST", "/api/projects", { name, desc, deadline });
    closeModal("modal-project");
    await renderProjects();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

async function renderProjects() {
  projects = await api("GET", "/api/projects");
  const allTasks = await api("GET", "/api/tasks");

  const grid = document.getElementById("projects-grid");
  const empty = document.getElementById("projects-empty");
  grid.innerHTML = "";

  if (projects.length === 0) {
    empty.textContent = isAdmin() ? 'No projects yet. Click "New Project" to create your first one.' : "You haven't been assigned to any projects yet.";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  projects.forEach(project => {
    const projTasks = allTasks.filter(t => t.projectId === project.id);
    const done = projTasks.filter(t => t.status === "done").length;
    const pct = projTasks.length ? Math.round((done / projTasks.length) * 100) : 0;

    const card = document.createElement("div");
    card.className = "project-card";

    const avatars = project.memberIds
      .map(mid => team.find(m => m.id === mid))
      .filter(Boolean)
      .map(m => `<div class="avatar" style="background:${colorFor(m.id)}" title="${escapeHtml(m.name)}">${initialsOf(m.name)}</div>`)
      .join("");

    card.innerHTML = `
      <h3>${escapeHtml(project.name)}</h3>
      <div class="desc">${escapeHtml(project.desc || "No description")}</div>
      <div class="meta-row">
        <span>${projTasks.length} task${projTasks.length === 1 ? "" : "s"} · ${pct}% done</span>
        <span>${project.deadline ? "Due " + project.deadline : ""}</span>
      </div>
      <div class="meta-row">
        <div class="avatar-stack">${avatars || '<span style="color:var(--text-muted)">No teammates yet</span>'}</div>
      </div>
      <div class="card-actions">
        <button data-action="board">Open board</button>
        ${isAdmin() ? '<button data-action="assign">Assign team</button><button data-action="delete">Delete</button>' : ""}
      </div>
    `;

    card.querySelector('[data-action="board"]').addEventListener("click", (e) => {
      e.stopPropagation();
      openBoard(project.id);
    });
    if (isAdmin()) {
      card.querySelector('[data-action="assign"]').addEventListener("click", (e) => {
        e.stopPropagation();
        openAssignModal(project.id);
      });
      card.querySelector('[data-action="delete"]').addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete project "${project.name}" and all its tasks?`)) return;
        try {
          await api("DELETE", `/api/projects/${project.id}`);
          await renderProjects();
        } catch (err) { alert(err.message); }
      });
    }
    card.addEventListener("click", () => openBoard(project.id));

    grid.appendChild(card);
  });
}

/* ---------- Assign teammates to a project (admin only) ---------- */
async function openAssignModal(projectId) {
  const project = projects.find(p => p.id === projectId);
  if (!project) return;
  team = await api("GET", "/api/team-lite");

  document.getElementById("assign-project-name").textContent = project.name;
  const list = document.getElementById("assign-list");
  list.innerHTML = "";

  if (team.length === 0) {
    list.innerHTML = '<p class="empty-hint">No teammates yet. Add some from the Team tab first.</p>';
  } else {
    team.forEach(m => {
      const row = document.createElement("div");
      row.className = "assign-row";
      const checked = project.memberIds.includes(m.id) ? "checked" : "";
      row.innerHTML = `
        <div class="avatar" style="background:${colorFor(m.id)}">${initialsOf(m.name)}</div>
        <div class="info">${escapeHtml(m.name)}</div>
        <input type="checkbox" ${checked} data-member="${m.id}">
      `;
      row.querySelector("input").addEventListener("change", async (e) => {
        let ids = project.memberIds.slice();
        if (e.target.checked) { if (!ids.includes(m.id)) ids.push(m.id); }
        else { ids = ids.filter(id => id !== m.id); }
        try {
          const updated = await api("PATCH", `/api/projects/${project.id}`, { memberIds: ids });
          project.memberIds = updated.memberIds;
          await renderProjects();
        } catch (err) { alert(err.message); }
      });
      list.appendChild(row);
    });
  }

  openModal("modal-assign");
}

/* ===========================================================
   TEAM (admin only)
=========================================================== */

document.getElementById("btn-new-member").addEventListener("click", () => {
  document.getElementById("member-modal-title").textContent = "Add Teammate";
  document.getElementById("input-member-name").value = "";
  document.getElementById("input-member-pin").value = "";
  document.getElementById("input-member-pin").placeholder = "e.g. 4821";
  document.getElementById("input-member-admin").checked = false;
  document.getElementById("member-error").textContent = "";
  delete document.getElementById("btn-save-member").dataset.editId;
  openModal("modal-member");
});

document.getElementById("btn-save-member").addEventListener("click", async () => {
  const btn = document.getElementById("btn-save-member");
  const errEl = document.getElementById("member-error");
  errEl.textContent = "";
  const name = document.getElementById("input-member-name").value.trim();
  const pin = document.getElementById("input-member-pin").value.trim();
  const admin = document.getElementById("input-member-admin").checked;
  if (!name) { errEl.textContent = "Please enter a name."; return; }
  const editId = btn.dataset.editId;

  try {
    if (editId) {
      const body = { name, role: admin ? "admin" : "member" };
      if (pin) body.pin = pin;
      await api("PATCH", `/api/members/${editId}`, body);
    } else {
      if (!pin) { errEl.textContent = "Please set a PIN."; return; }
      await api("POST", "/api/members", { name, pin, role: admin ? "admin" : "member" });
    }
    closeModal("modal-member");
    await renderTeam();
  } catch (err) {
    errEl.textContent = err.message;
  }
});

function openEditMember(m) {
  document.getElementById("member-modal-title").textContent = "Edit Teammate";
  document.getElementById("input-member-name").value = m.name;
  document.getElementById("input-member-pin").value = "";
  document.getElementById("input-member-pin").placeholder = "Leave blank to keep current PIN";
  document.getElementById("input-member-admin").checked = m.role === "admin";
  document.getElementById("member-error").textContent = "";
  document.getElementById("btn-save-member").dataset.editId = m.id;
  openModal("modal-member");
}

async function renderTeam() {
  members = await api("GET", "/api/members");
  team = await api("GET", "/api/team-lite");

  const grid = document.getElementById("team-grid");
  const empty = document.getElementById("team-empty");
  grid.innerHTML = "";

  if (members.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  members.forEach(m => {
    const card = document.createElement("div");
    card.className = "member-card";
    card.innerHTML = `
      <div class="avatar" style="background:${colorFor(m.id)}">${initialsOf(m.name)}</div>
      <div class="info">
        <div class="name">${escapeHtml(m.name)} ${m.role === "admin" ? '<span class="admin-badge">Admin</span>' : ""}</div>
      </div>
      <div class="actions">
        <button class="reset-pin-btn" data-action="edit">Edit</button>
        <button class="remove-btn" title="Remove">&times;</button>
      </div>
    `;
    card.querySelector('[data-action="edit"]').addEventListener("click", () => openEditMember(m));
    card.querySelector(".remove-btn").addEventListener("click", async () => {
      if (!confirm(`Remove ${m.name} from the team? They will no longer be able to log in.`)) return;
      try {
        await api("DELETE", `/api/members/${m.id}`);
        await renderTeam();
      } catch (err) { alert(err.message); }
    });
    grid.appendChild(card);
  });
}

/* ===========================================================
   BOARD (working process per project)
=========================================================== */

async function openBoard(projectId) {
  currentBoardProjectId = projectId;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-board").classList.add("active");
  navButtons.forEach(b => b.classList.remove("active"));
  await loadAndRenderBoard();
}

async function loadAndRenderBoard() {
  let project = projects.find(p => p.id === currentBoardProjectId);
  if (!project) {
    projects = await api("GET", "/api/projects");
    project = projects.find(p => p.id === currentBoardProjectId);
  }
  if (!project) { await showView("projects"); return; }

  document.getElementById("board-title").textContent = project.name;
  document.getElementById("board-subtitle").textContent = project.desc || "";

  try {
    groups = await api("GET", `/api/groups?projectId=${currentBoardProjectId}`);
    tasks = await api("GET", `/api/tasks?projectId=${currentBoardProjectId}`);
  } catch (err) {
    alert(err.message);
    await showView("projects");
    return;
  }
  renderBoard();
}

/* ---------- Editable project title (admin only) ---------- */
document.getElementById("board-title").addEventListener("click", () => {
  if (!isAdmin()) return;
  const titleEl = document.getElementById("board-title");
  if (titleEl.querySelector("input")) return;
  const project = projects.find(p => p.id === currentBoardProjectId);
  if (!project) return;
  const input = document.createElement("input");
  input.type = "text";
  input.value = project.name;
  titleEl.textContent = "";
  titleEl.appendChild(input);
  input.focus();
  input.select();
  const commit = async () => {
    const v = input.value.trim();
    if (v && v !== project.name) {
      try {
        const updated = await api("PATCH", `/api/projects/${project.id}`, { name: v });
        project.name = updated.name;
      } catch (err) { alert(err.message); }
    }
    titleEl.textContent = project.name;
  };
  input.addEventListener("blur", commit);
  input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); });
  input.addEventListener("click", e => e.stopPropagation());
});

/* ---------- Add new group (admin only) ---------- */
document.getElementById("btn-add-group").addEventListener("click", () => {
  const container = document.getElementById("board-groups");
  const row = document.createElement("div");
  row.className = "add-group-row";
  row.innerHTML = `<input type="text" placeholder="New group name">`;
  container.appendChild(row);
  const input = row.querySelector("input");
  input.focus();
  const commit = async () => {
    if (!row.isConnected) return;
    const name = input.value.trim();
    row.remove();
    if (!name) return;
    try {
      await api("POST", "/api/groups", { projectId: currentBoardProjectId, name });
    } catch (err) { alert(err.message); }
    await loadAndRenderBoard();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape" && row.isConnected) row.remove();
  });
  input.addEventListener("blur", commit);
});

/* ---------- Popover helper ---------- */
function closeAllPopovers() {
  document.querySelectorAll(".popover").forEach(p => p.remove());
}
document.addEventListener("click", closeAllPopovers);

function showPopover(anchor, fillFn) {
  closeAllPopovers();
  const pop = document.createElement("div");
  pop.className = "popover";
  fillFn(pop);
  document.body.appendChild(pop);
  const rect = anchor.getBoundingClientRect();
  pop.style.top = (window.scrollY + rect.bottom + 4) + "px";
  pop.style.left = (window.scrollX + rect.left) + "px";
  pop.addEventListener("click", e => e.stopPropagation());
  return pop;
}

/* ---------- Status picker (member: pick only) ---------- */
function renderStatusPicker(pop, task) {
  pop.innerHTML = "";
  statuses.forEach(s => {
    const row = document.createElement("div");
    row.className = "status-picker-item";
    row.innerHTML = `<span class="swatch" style="background:${s.color}"></span>${escapeHtml(s.label)}`;
    row.addEventListener("click", async () => {
      try {
        await api("PATCH", `/api/tasks/${task.id}`, { status: s.id });
      } catch (err) { alert(err.message); }
      closeAllPopovers();
      await loadAndRenderBoard();
    });
    pop.appendChild(row);
  });
}

/* ---------- Status editor (admin: add/rename/recolor/delete) ---------- */
function renderStatusEditor(pop, task) {
  pop.innerHTML = "";

  statuses.forEach(s => {
    const row = document.createElement("div");
    row.className = "status-edit-row";

    const swatch = document.createElement("input");
    swatch.type = "color";
    swatch.className = "status-color-input";
    swatch.value = s.color;
    swatch.title = "Change color";
    swatch.addEventListener("click", e => e.stopPropagation());
    swatch.addEventListener("input", () => {
      s.color = swatch.value;
      renderBoard();
    });
    swatch.addEventListener("change", async () => {
      try { await api("PATCH", `/api/statuses/${s.id}`, { color: s.color }); } catch (err) { alert(err.message); }
    });

    const label = document.createElement("input");
    label.type = "text";
    label.className = "status-label-input";
    label.value = s.label;
    label.addEventListener("click", e => e.stopPropagation());
    label.addEventListener("input", () => {
      s.label = label.value;
      renderBoard();
    });
    label.addEventListener("blur", async () => {
      try { await api("PATCH", `/api/statuses/${s.id}`, { label: s.label }); } catch (err) { alert(err.message); }
    });
    label.addEventListener("keydown", e => { if (e.key === "Enter") label.blur(); });

    const delBtn = document.createElement("button");
    delBtn.className = "status-edit-del";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Remove status";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (statuses.length <= 1) { alert("You need at least one status."); return; }
      try {
        await api("DELETE", `/api/statuses/${s.id}`);
        statuses = await api("GET", "/api/statuses");
      } catch (err) { alert(err.message); return; }
      renderStatusEditor(pop, task);
      renderBoard();
    });

    row.addEventListener("click", async () => {
      try {
        await api("PATCH", `/api/tasks/${task.id}`, { status: s.id });
      } catch (err) { alert(err.message); }
      closeAllPopovers();
      await loadAndRenderBoard();
    });

    row.append(swatch, label, delBtn);
    pop.appendChild(row);
  });

  const addRow = document.createElement("div");
  addRow.className = "status-edit-add";
  addRow.innerHTML = `<span class="plus">+</span> Add status`;
  addRow.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const created = await api("POST", "/api/statuses", { label: "New Status", color: "#579bfc" });
      statuses.push(created);
    } catch (err) { alert(err.message); return; }
    renderStatusEditor(pop, task);
    const rows = pop.querySelectorAll(".status-edit-row");
    const newLabel = rows.length ? rows[rows.length - 1].querySelector(".status-label-input") : null;
    if (newLabel) { newLabel.focus(); newLabel.select(); }
  });
  pop.appendChild(addRow);
}

/* ---------- Board rendering ---------- */
function renderBoard() {
  if (!currentBoardProjectId) return;
  const container = document.getElementById("board-groups");
  container.innerHTML = "";
  groups.forEach(group => container.appendChild(buildGroupTable(group)));
}

function buildGroupTable(group) {
  const project = projects.find(p => p.id === currentBoardProjectId);
  const groupTasks = tasks.filter(t => t.groupId === group.id);
  const topTasks = groupTasks.filter(t => !t.parentId);

  const wrap = document.createElement("div");
  wrap.className = "board-table-wrap";

  /* group bar */
  const bar = document.createElement("div");
  bar.className = "group-bar";

  const chevron = document.createElement("span");
  chevron.className = "group-chevron";
  chevron.innerHTML = "&#9662;";

  const titleEl = document.createElement("span");
  titleEl.className = "group-title";
  titleEl.textContent = group.name;

  if (isAdmin()) {
    titleEl.title = "Click to rename";
    titleEl.addEventListener("click", (e) => {
      e.stopPropagation();
      if (titleEl.querySelector("input")) return;
      const input = document.createElement("input");
      input.type = "text";
      input.value = group.name;
      titleEl.textContent = "";
      titleEl.appendChild(input);
      input.focus();
      input.select();
      const commit = async () => {
        const v = input.value.trim();
        if (v && v !== group.name) {
          try { await api("PATCH", `/api/groups/${group.id}`, { name: v }); } catch (err) { alert(err.message); }
        }
        await loadAndRenderBoard();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); });
      input.addEventListener("click", ev => ev.stopPropagation());
    });
  } else {
    titleEl.style.cursor = "default";
  }

  const countEl = document.createElement("span");
  countEl.className = "group-count";
  countEl.textContent = groupTasks.length + (groupTasks.length === 1 ? " item" : " items");

  bar.append(chevron, titleEl, countEl);

  if (isAdmin()) {
    const delGroupBtn = document.createElement("button");
    delGroupBtn.className = "group-del";
    delGroupBtn.innerHTML = "&times;";
    delGroupBtn.title = "Delete group";
    delGroupBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete group "${group.name}" and all its tasks?`)) return;
      try { await api("DELETE", `/api/groups/${group.id}`); } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    });
    bar.appendChild(delGroupBtn);
  }

  /* table */
  const table = document.createElement("table");
  table.className = "task-table";
  table.innerHTML = `<thead><tr>
    <th class="col-task">Task</th>
    <th class="col-owner">Owner</th>
    <th class="col-status">Status</th>
    <th class="col-due">Due date</th>
    <th class="col-timeline">Timeline</th>
    <th class="col-actions"></th>
  </tr></thead>`;
  const tbody = document.createElement("tbody");

  topTasks.forEach(task => {
    tbody.appendChild(buildTaskRow(task, project, groupTasks, false));
    const subitems = groupTasks.filter(t => t.parentId === task.id);
    if (!collapsedTasks.has(task.id)) {
      subitems.forEach(sub => tbody.appendChild(buildTaskRow(sub, project, groupTasks, true)));
      if (isAdmin()) tbody.appendChild(buildAddSubitemRow(task, group));
    }
  });

  table.appendChild(tbody);
  wrap.append(bar, table);

  if (isAdmin()) {
    const addRow = document.createElement("div");
    addRow.className = "add-task-row";
    addRow.innerHTML = `<span class="plus">+</span><input type="text" placeholder="Add task">`;
    const addInput = addRow.querySelector("input");
    addRow.addEventListener("click", () => addInput.focus());
    addInput.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      const title = addInput.value.trim();
      if (!title) return;
      try {
        await api("POST", "/api/tasks", { projectId: currentBoardProjectId, groupId: group.id, title });
      } catch (err) { alert(err.message); }
      addInput.value = "";
      await loadAndRenderBoard();
    });
    wrap.appendChild(addRow);
  }

  wrap.appendChild(buildSummaryRow(groupTasks));

  if (groupTasks.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.style.padding = "4px 16px 12px";
    hint.textContent = isAdmin() ? 'No tasks yet. Use "+ Add task" above to create one.' : "No tasks in this group yet.";
    wrap.appendChild(hint);
  }

  return wrap;
}

function buildTaskRow(task, project, groupTasks, isSub) {
  const tr = document.createElement("tr");
  tr.dataset.taskId = task.id;
  if (isSub) tr.classList.add("sub-row");

  const member = team.find(m => m.id === task.assigneeId);
  const statusDef = statuses.find(s => s.id === task.status) || statuses[0];

  const tdTask = document.createElement("td");
  tdTask.className = "cell-task";

  if (!isSub) {
    const subCount = groupTasks.filter(t => t.parentId === task.id).length;
    if (subCount > 0) {
      const toggle = document.createElement("button");
      toggle.className = "task-toggle";
      toggle.innerHTML = collapsedTasks.has(task.id) ? "&#9656;" : "&#9662;";
      toggle.title = "Expand/collapse subitems";
      toggle.addEventListener("click", (e) => {
        e.stopPropagation();
        if (collapsedTasks.has(task.id)) collapsedTasks.delete(task.id);
        else collapsedTasks.add(task.id);
        renderBoard();
      });
      tdTask.appendChild(toggle);
    }
  }

  const titleSpan = document.createElement("span");
  titleSpan.className = "task-title-text";
  titleSpan.textContent = task.title;
  tdTask.appendChild(titleSpan);

  if (isAdmin()) {
    tdTask.addEventListener("click", (e) => {
      e.stopPropagation();
      if (tdTask.querySelector("input")) return;
      const input = document.createElement("input");
      input.type = "text";
      input.value = task.title;
      tdTask.innerHTML = "";
      tdTask.appendChild(input);
      input.focus();
      input.select();
      const commit = async () => {
        const v = input.value.trim();
        if (v && v !== task.title) {
          try { await api("PATCH", `/api/tasks/${task.id}`, { title: v }); } catch (err) { alert(err.message); }
        }
        await loadAndRenderBoard();
      };
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); });
    });
  }

  const tdOwner = document.createElement("td");
  const ownerCell = document.createElement("div");
  ownerCell.className = "owner-cell";
  if (member) {
    ownerCell.innerHTML = `<div class="avatar" style="background:${colorFor(member.id)}">${initialsOf(member.name)}</div><span>${escapeHtml(member.name)}</span>`;
  } else {
    ownerCell.innerHTML = isAdmin()
      ? `<span class="add-owner">+</span><span>Assign</span>`
      : `<span>Unassigned</span>`;
  }
  if (isAdmin()) {
    ownerCell.addEventListener("click", (e) => {
      e.stopPropagation();
      const eligible = project.memberIds.map(mid => team.find(m => m.id === mid)).filter(Boolean);
      showPopover(ownerCell, (pop) => {
        if (eligible.length === 0) {
          pop.innerHTML = `<div class="popover-item" style="cursor:default;color:var(--text-muted)">Assign teammates to this project first</div>`;
          return;
        }
        pop.innerHTML = `<div class="popover-item" data-id="">Unassigned</div>` +
          eligible.map(m => `<div class="popover-item" data-id="${m.id}">
            <div class="avatar" style="background:${colorFor(m.id)};margin-left:0;width:20px;height:20px;font-size:10px;border:none">${initialsOf(m.name)}</div>
            ${escapeHtml(m.name)}
          </div>`).join("");
        pop.querySelectorAll(".popover-item[data-id]").forEach(item => {
          item.addEventListener("click", async () => {
            try {
              await api("PATCH", `/api/tasks/${task.id}`, { assigneeId: item.dataset.id || null });
            } catch (err) { alert(err.message); }
            closeAllPopovers();
            await loadAndRenderBoard();
          });
        });
      });
    });
  } else {
    ownerCell.style.cursor = "default";
  }
  tdOwner.appendChild(ownerCell);

  const tdStatus = document.createElement("td");
  const statusPill = document.createElement("span");
  statusPill.className = "status-pill";
  statusPill.style.background = statusDef.color;
  statusPill.textContent = statusDef.label;

  const canEditStatus = isAdmin() || (!!me && task.assigneeId === me.id);
  if (canEditStatus) {
    statusPill.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopover(statusPill, (pop) => {
        if (isAdmin()) {
          pop.classList.add("status-editor");
          renderStatusEditor(pop, task);
        } else {
          renderStatusPicker(pop, task);
        }
      });
    });
  } else {
    statusPill.classList.add("readonly");
  }
  tdStatus.appendChild(statusPill);

  const tdDue = document.createElement("td");
  tdDue.className = "cell-due";
  const duePill = document.createElement("span");
  duePill.className = "due-pill" + (task.dueDate ? " has-date" : "");
  duePill.textContent = task.dueDate ? formatDate(task.dueDate) : (isAdmin() ? "Set date" : "—");
  if (isAdmin()) {
    duePill.addEventListener("click", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.type = "date";
      input.value = task.dueDate || "";
      tdDue.innerHTML = "";
      tdDue.appendChild(input);
      input.focus();
      if (input.showPicker) { try { input.showPicker(); } catch (err) {} }
      const commit = async () => {
        try { await api("PATCH", `/api/tasks/${task.id}`, { dueDate: input.value }); } catch (err) { alert(err.message); }
        await loadAndRenderBoard();
      };
      input.addEventListener("change", commit);
      input.addEventListener("blur", commit);
    });
  } else {
    duePill.style.cursor = "default";
  }
  tdDue.appendChild(duePill);

  const tdTimeline = document.createElement("td");
  tdTimeline.className = "timeline-cell";
  tdTimeline.appendChild(buildTimelineEl(task, groupTasks));
  if (isAdmin()) {
    tdTimeline.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopover(tdTimeline, (pop) => {
        pop.classList.add("popover-timeline");
        pop.innerHTML = `
          <label>Start date<input type="date" id="pop-start" value="${task.start || ""}"></label>
          <label>End date<input type="date" id="pop-end" value="${task.end || ""}"></label>
          <button class="btn btn-primary" id="pop-save">Save</button>
        `;
        pop.querySelector("#pop-save").addEventListener("click", async () => {
          const start = pop.querySelector("#pop-start").value;
          const end = pop.querySelector("#pop-end").value;
          try { await api("PATCH", `/api/tasks/${task.id}`, { start, end }); } catch (err) { alert(err.message); }
          closeAllPopovers();
          await loadAndRenderBoard();
        });
      });
    });
  } else {
    tdTimeline.style.cursor = "default";
  }

  const tdActions = document.createElement("td");
  if (isAdmin()) {
    const delBtn = document.createElement("button");
    delBtn.className = "row-del";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Delete task";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await api("DELETE", `/api/tasks/${task.id}`); } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    });
    tdActions.appendChild(delBtn);
  }

  tr.append(tdTask, tdOwner, tdStatus, tdDue, tdTimeline, tdActions);
  return tr;
}

function buildAddSubitemRow(parentTask, group) {
  const tr = document.createElement("tr");
  const td = document.createElement("td");
  td.colSpan = 6;
  td.style.padding = "0";

  const row = document.createElement("div");
  row.className = "add-subitem-row";
  row.innerHTML = `<span class="plus">+</span><input type="text" placeholder="Add subitem">`;
  const input = row.querySelector("input");
  row.addEventListener("click", () => input.focus());
  input.addEventListener("keydown", async (e) => {
    if (e.key !== "Enter") return;
    const title = input.value.trim();
    if (!title) return;
    try {
      await api("POST", "/api/tasks", { projectId: currentBoardProjectId, groupId: group.id, title, parentId: parentTask.id });
    } catch (err) { alert(err.message); }
    input.value = "";
    await loadAndRenderBoard();
  });

  td.appendChild(row);
  tr.appendChild(td);
  return tr;
}

function buildTimelineEl(task, allTasks) {
  const wrap = document.createElement("div");
  if (!task.start || !task.end) {
    wrap.innerHTML = `<span class="timeline-placeholder">${isAdmin() ? "+ Set dates" : "—"}</span>`;
    return wrap;
  }
  const range = getOverallRange(allTasks);
  const track = document.createElement("div");
  track.className = "timeline-track";
  const fill = document.createElement("div");
  fill.className = "timeline-fill";
  const totalMs = Math.max(1, range.max - range.min);
  const left = ((new Date(task.start).getTime() - range.min) / totalMs) * 100;
  const width = Math.max(6, ((new Date(task.end).getTime() - new Date(task.start).getTime()) / totalMs) * 100);
  fill.style.left = Math.max(0, left) + "%";
  fill.style.width = Math.min(100, width) + "%";
  track.appendChild(fill);
  const label = document.createElement("div");
  label.className = "timeline-label";
  label.textContent = formatDate(task.start) + " – " + formatDate(task.end);
  wrap.appendChild(track);
  wrap.appendChild(label);
  return wrap;
}

function getOverallRange(tasksArr) {
  const dates = [];
  tasksArr.forEach(t => {
    if (t.start) dates.push(new Date(t.start).getTime());
    if (t.end) dates.push(new Date(t.end).getTime());
  });
  if (dates.length === 0) {
    const now = Date.now();
    return { min: now, max: now + 86400000 };
  }
  return { min: Math.min(...dates), max: Math.max(...dates) };
}

function formatDate(str) {
  if (!str) return "";
  const d = new Date(str + "T00:00:00");
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function buildSummaryRow(tasksArr) {
  const row = document.createElement("div");
  row.className = "summary-row";
  row.innerHTML = `
    <div class="summary-cell col-task">Overall</div>
    <div class="summary-cell col-owner"></div>
    <div class="summary-cell col-status"><div class="summary-status-bar"></div></div>
    <div class="summary-cell col-due"></div>
    <div class="summary-cell col-timeline"></div>
    <div class="summary-cell col-actions"></div>
  `;

  const bar = row.querySelector(".summary-status-bar");
  if (tasksArr.length === 0) {
    bar.style.background = "#edeef7";
  } else {
    statuses.forEach(s => {
      const count = tasksArr.filter(t => (statuses.find(x => x.id === t.status) || statuses[0]).id === s.id).length;
      if (!count) return;
      const seg = document.createElement("span");
      seg.style.width = ((count / tasksArr.length) * 100) + "%";
      seg.style.background = s.color;
      bar.appendChild(seg);
    });
  }

  const range = tasksArr.some(t => t.start && t.end) ? getOverallRange(tasksArr) : null;
  row.querySelector(".col-timeline").textContent = range
    ? formatDate(new Date(range.min).toISOString().slice(0, 10)) + " – " + formatDate(new Date(range.max).toISOString().slice(0, 10))
    : "";

  return row;
}

/* ===========================================================
   DASHBOARD
=========================================================== */

async function renderDashboard() {
  projects = await api("GET", "/api/projects");
  const allTasks = await api("GET", "/api/tasks");

  document.getElementById("stat-projects").textContent = projects.length;
  if (isAdmin()) {
    const allMembers = await api("GET", "/api/members");
    document.getElementById("stat-members").textContent = allMembers.length;
  }
  document.getElementById("stat-tasks").textContent = allTasks.length;

  const done = allTasks.filter(t => t.status === "done").length;
  const pct = allTasks.length ? Math.round((done / allTasks.length) * 100) : 0;
  document.getElementById("stat-done").textContent = pct + "%";

  const list = document.getElementById("progress-list");
  list.innerHTML = "";

  if (projects.length === 0) {
    list.innerHTML = `<p class="empty-hint">${isAdmin() ? "No projects yet. Create one from the Projects tab." : "You haven't been assigned to any projects yet."}</p>`;
    return;
  }

  projects.forEach(project => {
    const tks = allTasks.filter(t => t.projectId === project.id);
    const doneCount = tks.filter(t => t.status === "done").length;
    const pctP = tks.length ? Math.round((doneCount / tks.length) * 100) : 0;

    const item = document.createElement("div");
    item.className = "progress-item";
    item.innerHTML = `
      <div class="progress-top">
        <span class="pname">${escapeHtml(project.name)}</span>
        <span class="pct">${doneCount}/${tks.length} tasks · ${pctP}%</span>
      </div>
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${pctP}%"></div></div>
    `;
    list.appendChild(item);
  });
}

/* ---------- Init ---------- */
tryResume();
