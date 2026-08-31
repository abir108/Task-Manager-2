/* ===========================================================
   WorkFlow — Project Dashboard (multi-user, server-backed)
=========================================================== */

const COLORS = ["#5b5ff0", "#ef6a6a", "#f2b94a", "#6fcf97", "#3ec6e0", "#c46be0", "#e08a3e", "#4fbf8b"];

/* Inline SVG icons (not emoji) so they render consistently across browsers/OSes */
const ICON_CHAT = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
const ICON_PAPERCLIP = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`;
const ICON_PERSON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
const ICON_CALENDAR = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>`;
const ICON_FLAG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 3v18M4 4h13l-2.5 4L17 12H4"/></svg>`;

let me = null;
let team = [];       // {id, name} lite directory, visible to everyone logged in
let members = [];    // full roster with roles, admin only
let projects = [];
let groups = [];
let tasks = [];
let folders = [];
let categoryLabels = { running: "Running Projects", query: "Sent to Query", completed: "Completed Projects" };
let currentBoardProjectId = null;
let boardNotes = [];
let notesModalTaskId = null;
const collapsedGroups = new Set();
const expandedSubtaskCards = new Set();
const CATEGORY_KEYS = ["running", "query", "completed"];
let dragGroupReorderId = null;
let groupDragArmed = false;
let boardViewMode = localStorage.getItem("boardViewMode") || "kanban";
let projectsViewMode = localStorage.getItem("projectsViewMode") || "grid";
let projectsFilter = "all";
let projectsFolderFilter = "all";
let projectsSearchQuery = "";

function isAdmin() { return !!me && me.role === "admin"; }

/* ---------- Theme (dark / light) ---------- */
function applyTheme(theme) {
  document.body.classList.toggle("theme-dark", theme === "dark");
  const btn = document.getElementById("btn-theme-toggle");
  if (btn) btn.classList.toggle("active", theme === "dark");
}
(function initTheme() {
  const saved = localStorage.getItem("theme") || "light";
  applyTheme(saved);
})();
document.getElementById("btn-theme-toggle").addEventListener("click", () => {
  const next = document.body.classList.contains("theme-dark") ? "light" : "dark";
  localStorage.setItem("theme", next);
  applyTheme(next);
});

function initialsOf(name) {
  return name.trim().split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join("");
}
function colorFor(id) {
  let hash = 0;
  for (const ch of id) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length];
}

function avatarHtml(entity, extraStyle) {
  if (!entity) return "";
  const style = extraStyle || "";
  if (entity.avatarUrl) {
    return `<div class="avatar" style="overflow:hidden;background:#e4e6f0;${style}" title="${escapeHtml(entity.name)}"><img src="${entity.avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block"></div>`;
  }
  return `<div class="avatar" style="background:${colorFor(entity.id)};${style}" title="${escapeHtml(entity.name)}">${initialsOf(entity.name)}</div>`;
}
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function hexToRgba(hex, alpha) {
  const h = String(hex).replace("#", "");
  const full = h.length === 3 ? h.split("").map(c => c + c).join("") : h;
  const num = parseInt(full, 16);
  if (Number.isNaN(num)) return `rgba(120,120,120,${alpha})`;
  const r = (num >> 16) & 255, g = (num >> 8) & 255, b = num & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function showToast(message) {
  const stack = document.getElementById("toast-stack");
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("show"));
  setTimeout(() => {
    toast.classList.remove("show");
    setTimeout(() => toast.remove(), 200);
  }, 2600);
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
  me = null; team = []; members = []; projects = []; groups = []; tasks = []; folders = [];
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
  const avatarEl = document.getElementById("current-user-avatar");
  if (me.avatarUrl) {
    avatarEl.style.background = "";
    avatarEl.innerHTML = `<img src="${me.avatarUrl}" alt="" style="width:100%;height:100%;object-fit:cover;display:block">`;
  } else {
    avatarEl.style.background = colorFor(me.id);
    avatarEl.textContent = initialsOf(me.name);
  }
  document.getElementById("projects-subtitle").textContent = isAdmin()
    ? "Create and manage your projects"
    : "Projects you've been assigned to";
  document.getElementById("stat-members-card").style.display = isAdmin() ? "" : "none";
  showApp();
  team = await api("GET", "/api/team-lite");
  categoryLabels = await api("GET", "/api/category-labels");
  folders = await api("GET", "/api/folders");
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
  if ((name === "team" || name === "backup" || name === "archived" || name === "report") && !isAdmin()) name = "dashboard";
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-" + name).classList.add("active");
  navButtons.forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.querySelector(".main").classList.remove("main-wide");
  if (name === "dashboard") await renderDashboard();
  if (name === "projects") await renderProjects();
  if (name === "team") await renderTeam();
  if (name === "archived") await renderArchivedPage();
  if (name === "report") await renderReportPage();
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

function attachProjectActions(el, project) {
  el.querySelector('[data-action="board"]').addEventListener("click", (e) => {
    e.stopPropagation();
    openBoard(project.id);
  });
  if (isAdmin()) {
    const categorySelect = el.querySelector('[data-action="category"]');
    if (categorySelect) {
      categorySelect.addEventListener("click", e => e.stopPropagation());
      categorySelect.addEventListener("change", async (e) => {
        try {
          const updated = await api("PATCH", `/api/projects/${project.id}`, { category: e.target.value });
          project.category = updated.category;
          await renderProjects();
        } catch (err) { alert(err.message); }
      });
    }
    const folderSelect = el.querySelector('[data-action="folder"]');
    if (folderSelect) {
      folderSelect.addEventListener("click", e => e.stopPropagation());
      folderSelect.addEventListener("change", async (e) => {
        try {
          const updated = await api("PATCH", `/api/projects/${project.id}`, { folderId: e.target.value || null });
          project.folderId = updated.folderId;
          await renderProjects();
        } catch (err) { alert(err.message); }
      });
    }
    el.querySelector('[data-action="assign"]').addEventListener("click", (e) => {
      e.stopPropagation();
      openAssignModal(project.id);
    });
    const deleteBtn = el.querySelector('[data-action="delete"]');
    if (deleteBtn) {
      deleteBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Archive "${project.name}"? It will be moved to ${categoryLabels.archived || "Archived"} and hidden from the main list. You can restore it anytime from there, or delete it permanently.`)) return;
        try {
          const updated = await api("PATCH", `/api/projects/${project.id}`, { category: "archived" });
          project.category = updated.category;
          await renderProjects();
        } catch (err) { alert(err.message); }
      });
    }
  }
  el.addEventListener("click", () => openBoard(project.id));
}

function setProjectsViewMode(mode) {
  projectsViewMode = mode;
  localStorage.setItem("projectsViewMode", mode);
  document.getElementById("btn-view-grid").classList.toggle("active", mode === "grid");
  document.getElementById("btn-view-list").classList.toggle("active", mode === "list");
  document.getElementById("projects-grid").classList.toggle("hidden", mode !== "grid");
  document.getElementById("projects-list").classList.toggle("active", mode === "list");
}

document.getElementById("btn-view-grid").addEventListener("click", () => setProjectsViewMode("grid"));
document.getElementById("btn-view-list").addEventListener("click", () => setProjectsViewMode("list"));

document.getElementById("projects-search-input").addEventListener("input", (e) => {
  projectsSearchQuery = e.target.value.trim().toLowerCase();
  renderProjects();
});

function renderProjectsFilter() {
  const container = document.getElementById("projects-filter");
  container.innerHTML = "";

  const options = [{ key: "all", label: "All Projects", dot: null }].concat(
    CATEGORY_KEYS.map(key => ({ key, label: categoryLabels[key] || key, dot: key }))
  );

  options.forEach(opt => {
    const chip = document.createElement("button");
    chip.className = "filter-chip" + (projectsFilter === opt.key ? " active" : "");
    const count = opt.key === "all"
      ? projects.filter(p => (p.category || "running") !== "archived").length
      : projects.filter(p => (p.category || "running") === opt.key).length;
    chip.innerHTML = (opt.dot ? `<span class="dot" style="background:var(--cat-${opt.dot})"></span>` : "") +
      `${escapeHtml(opt.label)} (${count})`;
    chip.addEventListener("click", () => {
      projectsFilter = opt.key;
      renderProjects();
    });
    container.appendChild(chip);
  });
}

async function renderProjects() {
  projects = await api("GET", "/api/projects");
  const allTasks = await api("GET", "/api/tasks");

  const grid = document.getElementById("projects-grid");
  const list = document.getElementById("projects-list");
  const empty = document.getElementById("projects-empty");
  grid.innerHTML = "";
  list.innerHTML = "";
  setProjectsViewMode(projectsViewMode);
  renderProjectsFilter();
  renderFolderBar();

  if (projects.length === 0) {
    empty.textContent = isAdmin() ? 'No projects yet. Click "New Project" to create your first one.' : "You haven't been assigned to any projects yet.";
    empty.style.display = "block";
    return;
  }

  let filteredProjects = projectsFilter === "all"
    ? projects.filter(p => (p.category || "running") !== "archived")
    : projects.filter(p => (p.category || "running") === projectsFilter);
  if (projectsFolderFilter !== "all") {
    filteredProjects = filteredProjects.filter(p => p.folderId === projectsFolderFilter);
  }
  if (projectsSearchQuery) {
    filteredProjects = filteredProjects.filter(p => p.name.toLowerCase().includes(projectsSearchQuery));
  }

  if (filteredProjects.length === 0) {
    empty.textContent = projectsSearchQuery
      ? `No projects match "${projectsSearchQuery}".`
      : `No projects in "${categoryLabels[projectsFilter] || projectsFilter}".`;
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  filteredProjects.forEach(project => {
    const projTasks = allTasks.filter(t => t.projectId === project.id);
    const done = projTasks.filter(t => t.status === "done").length;
    const pct = projTasks.length ? Math.round((done / projTasks.length) * 100) : 0;
    const category = project.category || "running";
    const avatars = project.memberIds
      .map(mid => team.find(m => m.id === mid))
      .filter(Boolean)
      .map(m => avatarHtml(m))
      .join("");
    const categorySelectHtml = isAdmin() ? `<select class="category-select" data-action="category">
        ${CATEGORY_KEYS.map(k => `<option value="${k}" ${k === category ? "selected" : ""}>${escapeHtml(categoryLabels[k] || k)}</option>`).join("")}
      </select>` : "";
    const folderSelectHtml = isAdmin() ? `<select class="folder-select" data-action="folder" title="Assign to folder">
        <option value="">No folder</option>
        ${folders.map(f => `<option value="${f.id}" ${f.id === project.folderId ? "selected" : ""}>${escapeHtml(f.name)}</option>`).join("")}
      </select>` : "";
    const actionButtonsHtml = `
      <button data-action="board">Open board</button>
      ${isAdmin() ? '<button data-action="assign">Assign team</button><button data-action="delete">Delete</button>' : ""}
    `;

    const card = document.createElement("div");
    card.className = "project-card";
    card.innerHTML = `
      <div class="meta-row">
        <h3 style="margin:0">${escapeHtml(project.name)}</h3>
        <span class="category-badge ${category}">${escapeHtml(categoryLabels[category] || category)}</span>
      </div>
      <div class="desc">${escapeHtml(project.desc || "No description")}</div>
      <div class="meta-row">
        <span>${projTasks.length} task${projTasks.length === 1 ? "" : "s"} · ${pct}% done</span>
        <span>${project.deadline ? "Due " + project.deadline : ""}</span>
      </div>
      <div class="meta-row">
        <div class="avatar-stack">${avatars || '<span style="color:var(--text-muted)">No teammates yet</span>'}</div>
        ${categorySelectHtml}${folderSelectHtml}
      </div>
      <div class="card-actions">${actionButtonsHtml}</div>
    `;
    attachProjectActions(card, project);
    grid.appendChild(card);

    const row = document.createElement("div");
    row.className = "project-row";
    row.innerHTML = `
      <span class="pr-name">${escapeHtml(project.name)}</span>
      <span class="category-badge ${category}">${escapeHtml(categoryLabels[category] || category)}</span>
      <span class="pr-meta">${projTasks.length} task${projTasks.length === 1 ? "" : "s"} · ${pct}%</span>
      <div class="pr-progress"><div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${pct}%"></div></div></div>
      <div class="pr-avatars avatar-stack">${avatars}</div>
      ${categorySelectHtml}${folderSelectHtml}
      <div class="card-actions">${actionButtonsHtml}</div>
    `;
    attachProjectActions(row, project);
    list.appendChild(row);
  });
}

/* ---------- Archived projects (admin only) ---------- */
async function renderArchivedPage() {
  projects = await api("GET", "/api/projects");
  const archived = projects.filter(p => (p.category || "running") === "archived");
  const list = document.getElementById("archived-list");
  const empty = document.getElementById("archived-empty");
  list.innerHTML = "";

  if (archived.length === 0) {
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";

  const allTasks = await api("GET", "/api/tasks");

  archived.forEach(project => {
    const projTasks = allTasks.filter(t => t.projectId === project.id);
    const row = document.createElement("div");
    row.className = "project-row";
    row.innerHTML = `
      <span class="pr-name">${escapeHtml(project.name)}</span>
      <span class="category-badge archived">Archived</span>
      <span class="pr-meta">${projTasks.length} task${projTasks.length === 1 ? "" : "s"}</span>
      <div class="card-actions">
        <button data-action="board">Open board</button>
        <button data-action="restore">Restore</button>
        <button data-action="delete-permanent" class="danger">Delete Permanently</button>
      </div>
    `;
    row.querySelector('[data-action="board"]').addEventListener("click", (e) => {
      e.stopPropagation();
      openBoard(project.id);
    });
    row.querySelector('[data-action="restore"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api("PATCH", `/api/projects/${project.id}`, { category: "running" });
        await renderArchivedPage();
      } catch (err) { alert(err.message); }
    });
    row.querySelector('[data-action="delete-permanent"]').addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Permanently delete "${project.name}"? This removes it and all its tasks forever. This cannot be undone.`)) return;
      try {
        await api("DELETE", `/api/projects/${project.id}`);
        await renderArchivedPage();
      } catch (err) { alert(err.message); }
    });
    row.addEventListener("click", () => openBoard(project.id));
    list.appendChild(row);
  });
}

/* ---------- Custom folders (tag-like; live on the Projects page) ---------- */
function renderFolderBar() {
  const container = document.getElementById("projects-folder-bar");
  container.innerHTML = "";

  const allChip = document.createElement("button");
  allChip.type = "button";
  allChip.className = "folder-chip" + (projectsFolderFilter === "all" ? " active" : "");
  allChip.innerHTML = `<span class="dot"></span>All folders`;
  allChip.addEventListener("click", () => {
    projectsFolderFilter = "all";
    renderProjects();
  });
  container.appendChild(allChip);

  folders.forEach(folder => {
    const count = projects.filter(p => p.folderId === folder.id).length;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "folder-chip" + (projectsFolderFilter === folder.id ? " active" : "");
    chip.title = isAdmin() ? "Click to filter · double-click name to rename" : "Click to filter";

    const dot = document.createElement("span");
    dot.className = "dot";
    const label = document.createElement("span");
    label.className = "folder-chip-label";
    label.textContent = `${folder.name} (${count})`;
    chip.append(dot, label);

    chip.addEventListener("click", () => {
      projectsFolderFilter = projectsFolderFilter === folder.id ? "all" : folder.id;
      renderProjects();
    });

    if (isAdmin()) {
      label.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = document.createElement("input");
        input.type = "text";
        input.className = "folder-chip-new-input";
        input.value = folder.name;
        label.replaceWith(input);
        input.focus();
        input.select();
        let committed = false;
        const commit = async () => {
          if (committed) return;
          committed = true;
          const v = input.value.trim();
          if (v && v !== folder.name) {
            try {
              const updated = await api("PATCH", `/api/folders/${folder.id}`, { name: v });
              folder.name = updated.name;
            } catch (err) { alert(err.message); }
          }
          renderFolderBar();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", ev => {
          if (ev.key === "Enter") input.blur();
          if (ev.key === "Escape" && !committed) { committed = true; renderFolderBar(); }
        });
        input.addEventListener("click", ev => ev.stopPropagation());
      });

      const delBtn = document.createElement("button");
      delBtn.type = "button";
      delBtn.className = "folder-chip-del";
      delBtn.innerHTML = "&times;";
      delBtn.title = "Delete folder";
      delBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm(`Delete folder "${folder.name}"? Projects inside it are not deleted, just unassigned from this folder.`)) return;
        try {
          await api("DELETE", `/api/folders/${folder.id}`);
          folders = folders.filter(f => f.id !== folder.id);
          projects.forEach(p => { if (p.folderId === folder.id) p.folderId = null; });
          if (projectsFolderFilter === folder.id) projectsFolderFilter = "all";
        } catch (err) { alert(err.message); return; }
        renderProjects();
      });
      chip.appendChild(delBtn);
    }

    container.appendChild(chip);
  });

  if (isAdmin()) {
    const addBtn = document.createElement("button");
    addBtn.type = "button";
    addBtn.className = "folder-chip-add";
    addBtn.textContent = "+ New folder";
    addBtn.addEventListener("click", () => startNewFolderChipInput(container, addBtn));
    container.appendChild(addBtn);
  }
}

function startNewFolderChipInput(container, addBtn) {
  addBtn.style.display = "none";
  const input = document.createElement("input");
  input.type = "text";
  input.className = "folder-chip-new-input";
  input.placeholder = "Folder name";
  container.appendChild(input);
  input.focus();
  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
    const name = input.value.trim();
    input.remove();
    addBtn.style.display = "";
    if (!name) return;
    try {
      const created = await api("POST", "/api/folders", { name });
      folders.push(created);
    } catch (err) { alert(err.message); return; }
    renderFolderBar();
  };
  input.addEventListener("keydown", e => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape" && !committed) { committed = true; input.remove(); addBtn.style.display = ""; }
  });
  input.addEventListener("blur", commit);
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
        ${avatarHtml(m)}
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

let pendingAvatarUrl; // undefined = no change, string = new image, null = removed

function resetAvatarPicker(currentUrl) {
  pendingAvatarUrl = undefined;
  const preview = document.getElementById("member-avatar-preview");
  if (currentUrl) {
    preview.style.background = "";
    preview.innerHTML = `<img src="${currentUrl}" alt="">`;
  } else {
    preview.style.background = "";
    preview.textContent = "?";
  }
}

document.getElementById("input-member-avatar").addEventListener("change", (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => openCropModal(reader.result);
  reader.readAsDataURL(file);
});

document.getElementById("btn-remove-avatar").addEventListener("click", () => {
  pendingAvatarUrl = null;
  resetAvatarPicker(null);
});

/* ---------- Interactive avatar crop ---------- */
let cropState = null;
let cropDragStart = null;

function openCropModal(dataUrl) {
  const img = new Image();
  img.onload = () => {
    const frameSize = 240;
    const baseScale = frameSize / Math.min(img.naturalWidth, img.naturalHeight);
    const dispW = img.naturalWidth * baseScale;
    const dispH = img.naturalHeight * baseScale;
    cropState = {
      img, frameSize, baseScale, zoom: 1,
      offsetX: (frameSize - dispW) / 2,
      offsetY: (frameSize - dispH) / 2
    };
    const cropImg = document.getElementById("crop-image");
    cropImg.src = dataUrl;
    cropImg.style.width = dispW + "px";
    cropImg.style.height = dispH + "px";
    document.getElementById("crop-zoom").value = 1;
    applyCropTransform();
    openModal("modal-crop");
  };
  img.src = dataUrl;
}

function clampCropOffsets() {
  const dispW = cropState.img.naturalWidth * cropState.baseScale * cropState.zoom;
  const dispH = cropState.img.naturalHeight * cropState.baseScale * cropState.zoom;
  const minX = cropState.frameSize - dispW;
  const minY = cropState.frameSize - dispH;
  cropState.offsetX = Math.min(0, Math.max(minX, cropState.offsetX));
  cropState.offsetY = Math.min(0, Math.max(minY, cropState.offsetY));
}

function applyCropTransform() {
  document.getElementById("crop-image").style.transform =
    `translate(${cropState.offsetX}px, ${cropState.offsetY}px)`;
}

const cropFrame = document.getElementById("crop-frame");
cropFrame.addEventListener("pointerdown", (e) => {
  if (!cropState) return;
  cropDragStart = { x: e.clientX, y: e.clientY, offsetX: cropState.offsetX, offsetY: cropState.offsetY };
  cropFrame.setPointerCapture(e.pointerId);
});
cropFrame.addEventListener("pointermove", (e) => {
  if (!cropDragStart || !cropState) return;
  cropState.offsetX = cropDragStart.offsetX + (e.clientX - cropDragStart.x);
  cropState.offsetY = cropDragStart.offsetY + (e.clientY - cropDragStart.y);
  clampCropOffsets();
  applyCropTransform();
});
cropFrame.addEventListener("pointerup", () => { cropDragStart = null; });
cropFrame.addEventListener("pointercancel", () => { cropDragStart = null; });

document.getElementById("crop-zoom").addEventListener("input", (e) => {
  if (!cropState) return;
  const oldZoom = cropState.zoom;
  const newZoom = parseFloat(e.target.value);
  const cx = cropState.frameSize / 2;
  const cy = cropState.frameSize / 2;
  cropState.offsetX = cx - (cx - cropState.offsetX) * (newZoom / oldZoom);
  cropState.offsetY = cy - (cy - cropState.offsetY) * (newZoom / oldZoom);
  cropState.zoom = newZoom;
  const dispW = cropState.img.naturalWidth * cropState.baseScale * cropState.zoom;
  const dispH = cropState.img.naturalHeight * cropState.baseScale * cropState.zoom;
  const cropImg = document.getElementById("crop-image");
  cropImg.style.width = dispW + "px";
  cropImg.style.height = dispH + "px";
  clampCropOffsets();
  applyCropTransform();
});

document.getElementById("btn-save-crop").addEventListener("click", () => {
  if (!cropState) return;
  const { img, frameSize, baseScale, zoom, offsetX, offsetY } = cropState;
  const effScale = baseScale * zoom;
  const sourceX = -offsetX / effScale;
  const sourceY = -offsetY / effScale;
  const sourceSize = frameSize / effScale;
  const canvas = document.createElement("canvas");
  canvas.width = 200;
  canvas.height = 200;
  canvas.getContext("2d").drawImage(img, sourceX, sourceY, sourceSize, sourceSize, 0, 0, 200, 200);
  const dataUrl = canvas.toDataURL("image/jpeg", 0.85);
  pendingAvatarUrl = dataUrl;
  const preview = document.getElementById("member-avatar-preview");
  preview.style.background = "";
  preview.innerHTML = `<img src="${dataUrl}" alt="">`;
  closeModal("modal-crop");
  cropState = null;
});

document.getElementById("btn-new-member").addEventListener("click", () => {
  document.getElementById("member-modal-title").textContent = "Add Teammate";
  document.getElementById("input-member-name").value = "";
  document.getElementById("input-member-pin").value = "";
  document.getElementById("input-member-pin").placeholder = "e.g. 4821";
  document.getElementById("input-member-admin").checked = false;
  document.getElementById("member-error").textContent = "";
  resetAvatarPicker(null);
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
      if (pendingAvatarUrl !== undefined) body.avatarUrl = pendingAvatarUrl;
      await api("PATCH", `/api/members/${editId}`, body);
    } else {
      if (!pin) { errEl.textContent = "Please set a PIN."; return; }
      const body = { name, pin, role: admin ? "admin" : "member" };
      if (pendingAvatarUrl) body.avatarUrl = pendingAvatarUrl;
      await api("POST", "/api/members", body);
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
  resetAvatarPicker(m.avatarUrl);
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
      ${avatarHtml(m)}
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

/* ---------- Backup / restore (admin only) ---------- */
document.getElementById("btn-download-backup").addEventListener("click", () => {
  window.location.href = "/api/backup";
});

document.getElementById("input-restore-file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file) return;

  const statusEl = document.getElementById("backup-status");
  statusEl.textContent = "";
  statusEl.className = "backup-status";

  if (!confirm(`Restore from "${file.name}"? This replaces ALL current data (projects, tasks, and team logins) with what's in this backup. This can't be undone.`)) {
    return;
  }

  try {
    const text = await file.text();
    const data = JSON.parse(text);
    await api("POST", "/api/restore", data);
    statusEl.textContent = "Backup restored successfully.";
    statusEl.classList.add("success");
    team = await api("GET", "/api/team-lite");
    categoryLabels = await api("GET", "/api/category-labels");
    folders = await api("GET", "/api/folders");
    projects = await api("GET", "/api/projects");
  } catch (err) {
    statusEl.textContent = "Restore failed: " + err.message;
    statusEl.classList.add("error");
  }
});

/* ===========================================================
   BOARD (working process per project)
=========================================================== */

async function openBoard(projectId) {
  currentBoardProjectId = projectId;
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById("view-board").classList.add("active");
  navButtons.forEach(b => b.classList.remove("active"));
  document.querySelector(".main").classList.add("main-wide");
  await loadAndRenderBoard();
}

async function loadAndRenderBoard() {
  let project = projects.find(p => p.id === currentBoardProjectId);
  if (!project) {
    projects = await api("GET", "/api/projects");
    project = projects.find(p => p.id === currentBoardProjectId);
  }
  if (!project) { await showView("projects"); return; }

  try {
    groups = await api("GET", `/api/groups?projectId=${currentBoardProjectId}`);
    tasks = await api("GET", `/api/tasks?projectId=${currentBoardProjectId}`);
    boardNotes = await api("GET", `/api/notes?projectId=${currentBoardProjectId}`);
    projects = await api("GET", "/api/projects");
    project = projects.find(p => p.id === currentBoardProjectId) || project;
  } catch (err) {
    alert(err.message);
    await showView("projects");
    return;
  }
  document.getElementById("board-title").textContent = project.name;
  document.getElementById("board-subtitle").textContent = project.desc || "";
  renderBoard();
  loadInstructionsPanel(project);

  // Every task mutation (title/status/dates/owner/subitems) reloads the board
  // through here, so if the task detail modal is open, refresh it in place
  // from the freshly-fetched data instead of leaving it showing stale fields.
  if (taskDetailContext && document.getElementById("modal-task-detail").classList.contains("open")) {
    const openTask = tasks.find(t => t.id === taskDetailContext.taskId);
    const openGroup = groups.find(g => g.id === taskDetailContext.groupId);
    if (openTask && openGroup) {
      openTaskDetailModal(openTask, openGroup, project, tasks.filter(t => t.groupId === openGroup.id));
    } else {
      closeModal("modal-task-detail");
      taskDetailContext = null;
    }
  }
}

/* ---------- Project instructions panel (rich text) ---------- */
function sanitizeRichHtml(html) {
  const allowedTags = new Set(["B", "I", "U", "STRONG", "EM", "H2", "H3", "H4", "P", "BR", "DIV", "SPAN", "UL", "OL", "LI"]);
  const container = document.createElement("div");
  container.innerHTML = html;
  function clean(node) {
    Array.from(node.childNodes).forEach(child => {
      if (child.nodeType === 1) {
        if (!allowedTags.has(child.tagName)) {
          while (child.firstChild) node.insertBefore(child.firstChild, child);
          node.removeChild(child);
          return;
        }
        Array.from(child.attributes).forEach(attr => {
          if (attr.name.toLowerCase() !== "style") child.removeAttribute(attr.name);
        });
        clean(child);
      } else if (child.nodeType !== 3) {
        node.removeChild(child);
      }
    });
  }
  clean(container);
  return container.innerHTML;
}

function loadInstructionsPanel(project) {
  const content = document.getElementById("instructions-content");
  content.innerHTML = project.instructions || "";
  content.contentEditable = isAdmin() ? "true" : "false";
  content.classList.toggle("readonly", !isAdmin());
  // A saved selection Range from a previously-open project points at DOM
  // nodes this innerHTML swap just discarded — drop it so a toolbar click
  // made before the user has clicked/typed in this project's box doesn't
  // silently restore a stale, disconnected Range.
  savedInstructionsRange = null;
}

document.getElementById("instructions-content").addEventListener("blur", async () => {
  if (!isAdmin() || !currentBoardProjectId) return;
  const content = document.getElementById("instructions-content");
  const clean = sanitizeRichHtml(content.innerHTML);
  // Only touch the DOM if sanitizing actually removed something — reassigning
  // innerHTML destroys and recreates every node, which would silently break
  // any saved Selection/Range still pointing at the old ones (e.g. the
  // toolbar's chained-formatting support), even when blurring to a toolbar
  // control rather than leaving the panel.
  if (content.innerHTML !== clean) content.innerHTML = clean;
  const project = projects.find(p => p.id === currentBoardProjectId);
  if (project && project.instructions === clean) return;
  try {
    const updated = await api("PATCH", `/api/projects/${currentBoardProjectId}`, { instructions: clean });
    if (project) project.instructions = updated.instructions;
  } catch (err) { alert(err.message); }
});

/* Clicking a toolbar select/input normally steals focus (and the text
   selection) away from the contenteditable before its change/input event
   fires. Save the last real selection made inside the editor, and restore
   it right before applying a format from one of those controls. */
let savedInstructionsRange = null;
function saveInstructionsSelection() {
  const content = document.getElementById("instructions-content");
  const sel = window.getSelection();
  if (sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  if (content.contains(range.commonAncestorContainer)) {
    savedInstructionsRange = range.cloneRange();
  }
}
(function () {
  const content = document.getElementById("instructions-content");
  content.addEventListener("mouseup", saveInstructionsSelection);
  content.addEventListener("keyup", saveInstructionsSelection);
})();
function restoreInstructionsSelection() {
  const content = document.getElementById("instructions-content");
  content.focus();
  const sel = window.getSelection();
  if (savedInstructionsRange) {
    sel.removeAllRanges();
    try {
      sel.addRange(savedInstructionsRange);
      return;
    } catch (e) { /* stale range from a since-changed DOM */ }
  }
  // No usable saved range (fresh project, or a toolbar click before the user
  // clicked/typed here) — fall back to a caret at the end of the content so
  // execCommand still has somewhere valid to apply the format.
  if (sel.rangeCount === 0 || !content.contains(sel.getRangeAt(0).commonAncestorContainer)) {
    const range = document.createRange();
    range.selectNodeContents(content);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }
}
function wrapSelectionWithStyle(styleProp, value) {
  const sel = window.getSelection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const range = sel.getRangeAt(0);
  const span = document.createElement("span");
  span.style[styleProp] = value;
  span.appendChild(range.extractContents());
  range.insertNode(span);
  sel.removeAllRanges();
  const newRange = document.createRange();
  newRange.selectNodeContents(span);
  sel.addRange(newRange);
}
// Every toolbar action both restores the last known selection (in case focus
// moved away, e.g. to a <select>) and re-saves it afterward (since formatting
// commands can replace/rewrap DOM nodes, invalidating the old saved range) —
// so a second action right after the first still has something valid to work with.
function applyInstructionsFormat(fn) {
  restoreInstructionsSelection();
  fn();
  saveInstructionsSelection();
}

document.querySelectorAll("#instructions-toolbar [data-cmd]").forEach(btn => {
  // Keep focus (and the live selection) on the editor instead of the button.
  btn.addEventListener("mousedown", (e) => e.preventDefault());
  btn.addEventListener("click", () => {
    applyInstructionsFormat(() => document.execCommand(btn.dataset.cmd, false, null));
  });
});
document.getElementById("instructions-heading").addEventListener("change", (e) => {
  applyInstructionsFormat(() => document.execCommand("formatBlock", false, e.target.value));
});
document.getElementById("instructions-color").addEventListener("input", (e) => {
  applyInstructionsFormat(() => {
    document.execCommand("styleWithCSS", false, true);
    document.execCommand("foreColor", false, e.target.value);
  });
});
document.getElementById("instructions-fontsize").addEventListener("change", (e) => {
  const size = e.target.value;
  e.target.value = "";
  if (!size) return;
  applyInstructionsFormat(() => wrapSelectionWithStyle("fontSize", size));
});
document.getElementById("btn-instructions-collapse").addEventListener("click", () => {
  const panel = document.getElementById("board-instructions-panel");
  panel.classList.toggle("collapsed");
  localStorage.setItem("instructionsPanelCollapsed", panel.classList.contains("collapsed") ? "1" : "0");
});
if (localStorage.getItem("instructionsPanelCollapsed") === "1") {
  document.getElementById("board-instructions-panel").classList.add("collapsed");
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
  let committed = false;
  const commit = async () => {
    if (committed) return;
    committed = true;
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
    if (e.key === "Escape" && !committed) { committed = true; row.remove(); }
  });
  input.addEventListener("blur", commit);
});

/* ---------- Popover helper ---------- */
function closeAllPopovers() {
  document.querySelectorAll(".popover").forEach(p => p.remove());
}
document.addEventListener("click", closeAllPopovers);
document.addEventListener("mouseup", () => {
  groupDragArmed = false;
  document.querySelectorAll('.board-table-wrap[draggable="true"]').forEach(w => { w.draggable = false; });
});

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
function renderStatusPicker(pop, task, group) {
  pop.innerHTML = "";
  group.statuses.forEach(s => {
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

/* ---------- Status editor (admin: pick, recolor, rename via pencil, add/delete) ---------- */
function renderStatusEditor(pop, task, group) {
  pop.innerHTML = "";

  group.statuses.forEach(s => {
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
      try { await api("PATCH", `/api/groups/${group.id}/statuses/${s.id}`, { color: s.color }); } catch (err) { alert(err.message); }
    });

    const label = document.createElement("span");
    label.className = "status-label-text";
    label.textContent = s.label;

    const renameBtn = document.createElement("button");
    renameBtn.className = "status-edit-rename";
    renameBtn.innerHTML = "&#9998;";
    renameBtn.title = "Rename";
    renameBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const input = document.createElement("input");
      input.type = "text";
      input.className = "status-label-input";
      input.value = s.label;
      label.replaceWith(input);
      input.focus();
      input.select();
      const commit = async () => {
        const v = input.value.trim();
        s.label = v || s.label;
        try { await api("PATCH", `/api/groups/${group.id}/statuses/${s.id}`, { label: s.label }); } catch (err) { alert(err.message); }
        renderStatusEditor(pop, task, group);
        renderBoard();
      };
      input.addEventListener("click", ev => ev.stopPropagation());
      input.addEventListener("blur", commit);
      input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); });
    });

    const delBtn = document.createElement("button");
    delBtn.className = "status-edit-del";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Remove status";
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (group.statuses.length <= 1) { alert("You need at least one status."); return; }
      try {
        await api("DELETE", `/api/groups/${group.id}/statuses/${s.id}`);
        await loadAndRenderBoard();
        group = groups.find(g => g.id === group.id) || group;
      } catch (err) { alert(err.message); return; }
      renderStatusEditor(pop, task, group);
    });

    row.addEventListener("click", async () => {
      if (!task) return;
      try {
        await api("PATCH", `/api/tasks/${task.id}`, { status: s.id });
      } catch (err) { alert(err.message); }
      closeAllPopovers();
      await loadAndRenderBoard();
    });

    row.append(swatch, label, renameBtn, delBtn);
    pop.appendChild(row);
  });

  const addRow = document.createElement("div");
  addRow.className = "status-edit-add";
  addRow.innerHTML = `<span class="plus">+</span> Add status`;
  addRow.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      const created = await api("POST", `/api/groups/${group.id}/statuses`, { label: "New Status", color: "#579bfc" });
      group.statuses.push(created);
    } catch (err) { alert(err.message); return; }
    renderStatusEditor(pop, task, group);
    renderBoard();
  });
  pop.appendChild(addRow);
}

/* ---------- Board rendering ---------- */
function setBoardViewMode(mode) {
  boardViewMode = mode;
  localStorage.setItem("boardViewMode", mode);
  document.getElementById("btn-board-view-kanban").classList.toggle("active", mode === "kanban");
  document.getElementById("btn-board-view-list").classList.toggle("active", mode === "list");
}
document.getElementById("btn-board-view-kanban").addEventListener("click", () => { setBoardViewMode("kanban"); renderBoard(); });
document.getElementById("btn-board-view-list").addEventListener("click", () => { setBoardViewMode("list"); renderBoard(); });

function renderBoard() {
  if (!currentBoardProjectId) return;
  setBoardViewMode(boardViewMode);
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
  wrap.dataset.groupId = group.id;

  /* group bar */
  const bar = document.createElement("div");
  bar.className = "group-bar";

  const isCollapsed = collapsedGroups.has(group.id);

  if (isAdmin()) {
    const groupHandle = document.createElement("span");
    groupHandle.className = "group-drag-handle";
    groupHandle.innerHTML = "&#8942;&#8942;";
    groupHandle.title = "Drag to reorder group";
    groupHandle.addEventListener("mousedown", () => {
      groupDragArmed = true;
      wrap.draggable = true;
    });
    bar.appendChild(groupHandle);

    wrap.addEventListener("dragstart", (e) => {
      if (!groupDragArmed) { e.preventDefault(); return; }
      dragGroupReorderId = group.id;
      wrap.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setDragImage(bar, 16, 16);
    });
    wrap.addEventListener("dragend", () => {
      groupDragArmed = false;
      wrap.draggable = false;
      wrap.classList.remove("dragging");
      document.querySelectorAll(".board-table-wrap.drag-over-before,.board-table-wrap.drag-over-after")
        .forEach(el => el.classList.remove("drag-over-before", "drag-over-after"));
      dragGroupReorderId = null;
    });
    wrap.addEventListener("dragover", (e) => {
      if (!dragGroupReorderId) return;
      e.preventDefault();
      const rect = wrap.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      wrap.classList.toggle("drag-over-before", before);
      wrap.classList.toggle("drag-over-after", !before);
    });
    wrap.addEventListener("dragleave", () => {
      wrap.classList.remove("drag-over-before", "drag-over-after");
    });
    wrap.addEventListener("drop", async (e) => {
      e.preventDefault();
      wrap.classList.remove("drag-over-before", "drag-over-after");
      const draggedId = dragGroupReorderId;
      if (!draggedId || draggedId === group.id) return;
      const ids = groups.map(g => g.id);
      const fromIdx = ids.indexOf(draggedId);
      if (fromIdx > -1) ids.splice(fromIdx, 1);
      const rect = wrap.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      let toIdx = ids.indexOf(group.id);
      if (!before) toIdx += 1;
      ids.splice(toIdx, 0, draggedId);
      try {
        await api("POST", "/api/groups/reorder", { groupIds: ids });
      } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    });
  }

  const chevron = document.createElement("button");
  chevron.className = "group-chevron" + (isCollapsed ? " collapsed" : "");
  chevron.innerHTML = "&#9662;";
  chevron.title = "Expand/collapse group";
  chevron.addEventListener("click", (e) => {
    e.stopPropagation();
    if (collapsedGroups.has(group.id)) collapsedGroups.delete(group.id);
    else collapsedGroups.add(group.id);
    renderBoard();
  });

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
    const sendQueryBtn = document.createElement("button");
    sendQueryBtn.className = "group-send-query";
    sendQueryBtn.textContent = "Send Query";
    sendQueryBtn.title = `Adds a "Send Query" task — marking it Done moves this project to ${categoryLabels.query || "Sent to Query"}`;
    sendQueryBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api("POST", `/api/groups/${group.id}/send-query`);
        showToast(`"Send Query" task added — mark it Done to move this project to ${categoryLabels.query || "Sent to Query"}`);
      } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    });
    bar.appendChild(sendQueryBtn);

    const copyBtn = document.createElement("button");
    copyBtn.className = "group-copy";
    copyBtn.innerHTML = "&#10697;";
    copyBtn.title = "Copy this group";
    copyBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api("POST", `/api/groups/${group.id}/duplicate`);
        showToast(`"${group.name}" copied`);
      } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    });
    bar.appendChild(copyBtn);

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

  wrap.appendChild(bar);
  if (isCollapsed) return wrap;

  if (boardViewMode === "list") {
    wrap.appendChild(buildGroupList(group, topTasks, groupTasks, project));
  } else {
    /* kanban board: one column per status */
    const board = document.createElement("div");
    board.className = "kanban-board";
    board.dataset.groupId = group.id;
    group.statuses.forEach(status => {
      board.appendChild(buildKanbanColumn(status, group, topTasks, groupTasks, project));
    });
    wrap.appendChild(board);
  }

  wrap.appendChild(buildKanbanSummaryRow(groupTasks, group.statuses));

  return wrap;
}

/* ---------- List view (flat rows per group; alternative to the Kanban board) ---------- */
function buildGroupList(group, topTasks, groupTasks, project) {
  const wrap = document.createElement("div");
  wrap.className = "kanban-list";

  const header = document.createElement("div");
  header.className = "kanban-list-header-row";
  header.innerHTML = `<span class="kl-col-task">Task</span><span class="kl-col-status">Status</span><span class="kl-col-owner">Owner</span><span class="kl-col-due">Due date</span>`;
  wrap.appendChild(header);

  const listEl = document.createElement("div");
  listEl.className = "kanban-list-rows";
  topTasks.forEach(task => {
    listEl.appendChild(buildListRow(task, group, project, groupTasks));
  });
  wrap.appendChild(listEl);

  if (isAdmin()) {
    wrap.appendChild(buildKanbanQuickAdd(group.statuses[0], group, project));
  } else if (topTasks.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.style.padding = "8px 4px";
    hint.textContent = "No tasks in this group yet.";
    wrap.appendChild(hint);
  }

  return wrap;
}

function buildListRow(task, group, project, groupTasks) {
  const assigneeIds = task.assigneeIds || [];
  const assignedMembers = assigneeIds.map(id => team.find(m => m.id === id)).filter(Boolean);
  const subitems = groupTasks.filter(t => t.parentId === task.id);
  const statusDef = group.statuses.find(s => s.id === task.status) || group.statuses[0];
  const urgency = getUrgency(task.dueDate, task.status === "done");

  const row = document.createElement("div");
  row.className = "kanban-list-row";
  row.dataset.taskId = task.id;

  if (isAdmin()) {
    const handle = document.createElement("span");
    handle.className = "kl-drag-handle";
    handle.innerHTML = "&#8942;&#8942;";
    handle.title = "Drag to reorder";
    handle.addEventListener("mousedown", (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startListRowDrag(e, row);
    });
    row.appendChild(handle);
  }

  const titleCell = document.createElement("span");
  titleCell.className = "kl-col-task";
  titleCell.textContent = task.title;
  if (subitems.length > 0) {
    const subBadge = document.createElement("span");
    subBadge.className = "kl-sub-badge";
    subBadge.textContent = `${subitems.filter(s => s.status === "done").length}/${subitems.length}`;
    titleCell.appendChild(subBadge);
  }
  row.appendChild(titleCell);

  const statusCell = document.createElement("span");
  statusCell.className = "status-pill kl-col-status";
  statusCell.style.background = statusDef.color;
  statusCell.textContent = statusDef.label;
  row.appendChild(statusCell);

  const ownerCell = document.createElement("span");
  ownerCell.className = "kl-col-owner";
  ownerCell.innerHTML = assignedMembers.length
    ? assignedMembers.map(m => avatarHtml(m)).join("")
    : `<span class="kl-unassigned">Unassigned</span>`;
  row.appendChild(ownerCell);

  const dueCell = document.createElement("span");
  dueCell.className = "kl-col-due urgency-" + urgency.cls;
  dueCell.textContent = task.dueDate ? formatDate(task.dueDate) : "—";
  row.appendChild(dueCell);

  if (isAdmin()) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "kl-del";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Delete task";
    delBtn.addEventListener("mousedown", e => e.stopPropagation());
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await api("DELETE", `/api/tasks/${task.id}`); } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    });
    row.appendChild(delBtn);
  }

  row.addEventListener("click", (e) => {
    if (e.target.closest(".kl-drag-handle,.kl-del")) return;
    openTaskDetailModal(task, group, project, groupTasks);
  });

  return row;
}

/* Same live-move-on-drag approach as the kanban cards, simplified to a single
   flat list (List view has no columns to cross, just reorder in place). */
function startListRowDrag(startEvent, row) {
  const listEl = row.parentElement;
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;
  const THRESHOLD = 4;
  let dragging = false;

  function rows() { return Array.from(listEl.children); }

  function onMouseMove(e) {
    if (!dragging) {
      if (Math.abs(e.clientX - startX) < THRESHOLD && Math.abs(e.clientY - startY) < THRESHOLD) return;
      dragging = true;
      row.classList.add("dragging");
      document.body.classList.add("task-row-dragging");
    }
    for (const sib of rows()) {
      if (sib === row) continue;
      const r = sib.getBoundingClientRect();
      const mid = r.top + r.height / 2;
      const rowBeforeSib = !!(row.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING);
      if (e.clientY < mid && !rowBeforeSib) { listEl.insertBefore(row, sib); break; }
      if (e.clientY >= mid && rowBeforeSib) { listEl.insertBefore(row, sib.nextSibling); break; }
    }
  }

  async function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.classList.remove("task-row-dragging");
    row.classList.remove("dragging");
    if (!dragging) return;
    const topIds = rows().map(r => r.dataset.taskId);
    try {
      await api("POST", "/api/tasks/reorder", { taskIds: topIds });
    } catch (err) { alert(err.message); }
    await loadAndRenderBoard();
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

/* Custom mouse-driven reorder for top-level task rows (native HTML5 drag-and-drop
   proved unreliable to grab/drop reliably across browsers). While the mouse is
   down, the grabbed row (plus any subitem rows/add-subitem row that belong to
   it) is moved live in the DOM as the cursor crosses a neighboring task's
   midpoint, so the list visibly opens a gap and shifts as you drag -- the
   final DOM order on mouseup is sent to the server. */
/* ---------- Kanban board (one column per group status) ---------- */
function buildKanbanColumn(status, group, topTasks, groupTasks, project) {
  const colTasks = topTasks.filter(t => (t.status || group.statuses[0].id) === status.id);

  const col = document.createElement("div");
  col.className = "kanban-column";
  col.dataset.statusId = status.id;
  col.style.background = hexToRgba(status.color, 0.08);

  const header = document.createElement("div");
  header.className = "kanban-col-header";
  header.style.background = hexToRgba(status.color, 0.24);

  const dot = document.createElement("span");
  dot.className = "kanban-col-dot";
  dot.style.background = status.color;

  const label = document.createElement("span");
  label.className = "kanban-col-label";
  label.textContent = status.label;
  label.style.color = status.color;

  const count = document.createElement("span");
  count.className = "kanban-col-count";
  count.textContent = colTasks.length;

  if (isAdmin()) {
    label.title = "Click to rename";
    label.addEventListener("click", (e) => {
      e.stopPropagation();
      if (header.querySelector(".kanban-col-rename-input")) return;
      const input = document.createElement("input");
      input.type = "text";
      input.className = "kanban-col-rename-input";
      input.value = status.label;
      const confirmBtn = document.createElement("button");
      confirmBtn.type = "button";
      confirmBtn.className = "kanban-col-rename-confirm";
      confirmBtn.innerHTML = "&#10003;";
      label.replaceWith(input);
      header.insertBefore(confirmBtn, count);
      input.focus();
      input.select();
      let committed = false;
      const commit = async () => {
        if (committed) return;
        committed = true;
        const v = input.value.trim();
        if (v && v !== status.label) {
          try { await api("PATCH", `/api/groups/${group.id}/statuses/${status.id}`, { label: v }); } catch (err) { alert(err.message); }
        }
        await loadAndRenderBoard();
      };
      confirmBtn.addEventListener("mousedown", ev => ev.preventDefault());
      confirmBtn.addEventListener("click", commit);
      input.addEventListener("click", ev => ev.stopPropagation());
      input.addEventListener("keydown", ev => {
        if (ev.key === "Enter") commit();
        if (ev.key === "Escape" && !committed) { committed = true; renderBoard(); }
      });
      input.addEventListener("blur", () => { if (!committed) commit(); });
    });
  }

  header.append(dot, label, count);

  if (isAdmin()) {
    const gear = document.createElement("button");
    gear.type = "button";
    gear.className = "kanban-col-manage";
    gear.innerHTML = "&#8942;";
    gear.title = "Manage statuses";
    gear.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopover(gear, (pop) => {
        pop.classList.add("status-editor");
        renderStatusEditor(pop, null, group);
      });
    });
    header.appendChild(gear);
  }

  col.appendChild(header);

  const cardList = document.createElement("div");
  cardList.className = "kanban-card-list";
  colTasks.forEach(task => {
    cardList.appendChild(buildTaskCard(task, group, project, groupTasks));
  });
  col.appendChild(cardList);

  if (isAdmin()) {
    col.appendChild(buildKanbanQuickAdd(status, group, project));
  }

  return col;
}

function buildKanbanQuickAdd(status, group, project) {
  const wrap = document.createElement("div");
  wrap.className = "kanban-add-task";
  wrap.innerHTML = `<span class="plus">+</span> Add Task`;

  wrap.addEventListener("click", () => {
    if (wrap.classList.contains("open")) return;
    wrap.classList.add("open");
    wrap.innerHTML = "";

    let pendingAssigneeIds = [];
    let pendingDueDate = "";
    let committed = false;

    const card = document.createElement("div");
    card.className = "kanban-quick-add-card";

    const titleInput = document.createElement("input");
    titleInput.type = "text";
    titleInput.className = "kanban-quick-add-title";
    titleInput.placeholder = "Task Name...";
    card.appendChild(titleInput);

    const assigneeBtn = document.createElement("button");
    assigneeBtn.type = "button";
    assigneeBtn.className = "kanban-quick-add-field";
    assigneeBtn.innerHTML = `${ICON_PERSON} Add assignee`;
    card.appendChild(assigneeBtn);

    const dateBtn = document.createElement("button");
    dateBtn.type = "button";
    dateBtn.className = "kanban-quick-add-field";
    dateBtn.innerHTML = `${ICON_CALENDAR} Add dates`;
    card.appendChild(dateBtn);

    const actionsRow = document.createElement("div");
    actionsRow.className = "kanban-quick-add-actions";
    const saveBtn = document.createElement("button");
    saveBtn.type = "button";
    saveBtn.className = "btn btn-primary";
    saveBtn.innerHTML = "Save &crarr;";
    actionsRow.appendChild(saveBtn);
    card.appendChild(actionsRow);

    wrap.appendChild(card);
    titleInput.focus();

    assigneeBtn.addEventListener("mousedown", e => e.preventDefault());
    assigneeBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      const eligible = project.memberIds.map(mid => team.find(m => m.id === mid)).filter(Boolean);
      showPopover(assigneeBtn, (pop) => {
        if (eligible.length === 0) {
          pop.innerHTML = `<div class="popover-item" style="cursor:default;color:var(--text-muted)">Assign teammates to this project first</div>`;
          return;
        }
        let selected = new Set(pendingAssigneeIds);
        pop.innerHTML = eligible.map(m => `<div class="popover-item checkbox-item" data-id="${m.id}">
            <span style="display:flex;align-items:center;gap:8px">
              ${avatarHtml(m, "margin-left:0;width:20px;height:20px;font-size:10px;border:none")}
              ${escapeHtml(m.name)}
            </span>
            <input type="checkbox" ${selected.has(m.id) ? "checked" : ""}>
          </div>`).join("");
        pop.querySelectorAll(".popover-item[data-id]").forEach(item => {
          const checkbox = item.querySelector("input");
          const toggle = () => {
            const id = item.dataset.id;
            if (selected.has(id)) selected.delete(id); else selected.add(id);
            checkbox.checked = selected.has(id);
          };
          item.addEventListener("click", (ev) => { if (ev.target !== checkbox) toggle(); });
          checkbox.addEventListener("click", ev => ev.stopPropagation());
          checkbox.addEventListener("change", toggle);
        });
        const doneBtn = document.createElement("button");
        doneBtn.className = "popover-owner-done";
        doneBtn.textContent = "Done";
        doneBtn.addEventListener("click", () => {
          pendingAssigneeIds = Array.from(selected);
          assigneeBtn.innerHTML = pendingAssigneeIds.length
            ? `${ICON_PERSON} ${pendingAssigneeIds.length} assigned`
            : `${ICON_PERSON} Add assignee`;
          closeAllPopovers();
          titleInput.focus();
        });
        pop.appendChild(doneBtn);
      });
    });

    dateBtn.addEventListener("mousedown", e => e.preventDefault());
    dateBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopover(dateBtn, (pop) => {
        pop.classList.add("popover-timeline");
        pop.innerHTML = `<label>Due date<input type="date" id="qa-due" value="${pendingDueDate}"></label>`;
        const dueInput = pop.querySelector("#qa-due");
        dueInput.addEventListener("change", () => {
          pendingDueDate = dueInput.value;
          dateBtn.innerHTML = pendingDueDate ? `${ICON_CALENDAR} ${formatDate(pendingDueDate)}` : `${ICON_CALENDAR} Add dates`;
          closeAllPopovers();
          titleInput.focus();
        });
      });
    });

    const cancel = () => {
      if (committed) return;
      committed = true;
      renderBoard();
    };
    const commit = async () => {
      if (committed) return;
      const title = titleInput.value.trim();
      if (!title) { cancel(); return; }
      committed = true;
      try {
        await api("POST", "/api/tasks", {
          projectId: currentBoardProjectId, groupId: group.id, title, status: status.id,
          assigneeIds: pendingAssigneeIds, dueDate: pendingDueDate
        });
      } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    };
    saveBtn.addEventListener("mousedown", e => e.preventDefault());
    saveBtn.addEventListener("click", commit);
    titleInput.addEventListener("keydown", e => {
      if (e.key === "Enter") commit();
      if (e.key === "Escape") cancel();
    });
  });

  return wrap;
}

function buildTaskCard(task, group, project, groupTasks) {
  const assigneeIds = task.assigneeIds || [];
  const assignedMembers = assigneeIds.map(id => team.find(m => m.id === id)).filter(Boolean);
  const subitems = groupTasks.filter(t => t.parentId === task.id);
  const subDone = subitems.filter(t => t.status === "done").length;
  const noteCount = boardNotes.filter(n => n.taskId === task.id).length;
  const urgency = getUrgency(task.dueDate, task.status === "done");
  const canDrag = isAdmin() || (!!me && assigneeIds.includes(me.id));

  const cardWrap = document.createElement("div");
  cardWrap.className = "kanban-card-wrap";
  cardWrap.dataset.taskId = task.id;

  const card = document.createElement("div");
  card.className = "kanban-card";

  const titleEl = document.createElement("div");
  titleEl.className = "kanban-card-title";
  titleEl.textContent = task.title;
  card.appendChild(titleEl);

  const meta = document.createElement("div");
  meta.className = "kanban-card-meta";

  if (task.dueDate) {
    const due = document.createElement("span");
    due.className = "kanban-card-due urgency-" + urgency.cls;
    due.textContent = formatDate(task.dueDate);
    meta.appendChild(due);
  }
  if (noteCount > 0) {
    const noteBadge = document.createElement("span");
    noteBadge.className = "kanban-card-notes";
    noteBadge.innerHTML = `${ICON_CHAT}${noteCount}`;
    meta.appendChild(noteBadge);
  }
  if (assignedMembers.length > 0) {
    const avatars = document.createElement("div");
    avatars.className = "kanban-card-avatars";
    avatars.innerHTML = assignedMembers.map(m => avatarHtml(m)).join("");
    meta.appendChild(avatars);
  }
  card.appendChild(meta);

  if (isAdmin()) {
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "kanban-card-del";
    delBtn.innerHTML = "&times;";
    delBtn.title = "Delete task";
    delBtn.addEventListener("mousedown", e => e.stopPropagation());
    delBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      try { await api("DELETE", `/api/tasks/${task.id}`); } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    });
    card.appendChild(delBtn);
  }

  card.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (e.target.closest(".kanban-card-del")) return;
    e.preventDefault();
    startKanbanCardDrag(e, cardWrap, task, group, canDrag, project, groupTasks);
  });

  cardWrap.appendChild(card);

  if (subitems.length > 0) {
    const isExpanded = expandedSubtaskCards.has(task.id);
    const toggle = document.createElement("div");
    toggle.className = "kanban-subtask-toggle";
    toggle.innerHTML = `<span class="chevron">${isExpanded ? "&#9662;" : "&#9656;"}</span> ${subDone}/${subitems.length} subtasks`;
    toggle.addEventListener("mousedown", e => e.stopPropagation());
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (expandedSubtaskCards.has(task.id)) expandedSubtaskCards.delete(task.id);
      else expandedSubtaskCards.add(task.id);
      renderBoard();
    });
    cardWrap.appendChild(toggle);

    if (isExpanded) {
      const subList = document.createElement("div");
      subList.className = "kanban-subtask-list";
      subitems.forEach(sub => subList.appendChild(buildSubtaskMiniCard(sub, group, project, groupTasks)));
      cardWrap.appendChild(subList);
    }
  }

  return cardWrap;
}

function buildSubtaskMiniCard(sub, group, project, groupTasks) {
  const statusDef = group.statuses.find(s => s.id === sub.status) || group.statuses[0];
  const assigneeIds = sub.assigneeIds || [];
  const assignedMembers = assigneeIds.map(id => team.find(m => m.id === id)).filter(Boolean);

  const mini = document.createElement("div");
  mini.className = "kanban-subtask-card";

  const title = document.createElement("div");
  title.className = "kanban-subtask-card-title";
  title.textContent = sub.title;
  mini.appendChild(title);

  const iconsRow = document.createElement("div");
  iconsRow.className = "kanban-subtask-card-icons";
  const ownerIcon = document.createElement("span");
  ownerIcon.className = "ks-icon ks-owner";
  ownerIcon.innerHTML = assignedMembers.length ? avatarHtml(assignedMembers[0]) : ICON_PERSON;
  const statusIcon = document.createElement("span");
  statusIcon.className = "ks-icon ks-status";
  statusIcon.style.color = statusDef.color;
  statusIcon.title = statusDef.label;
  statusIcon.innerHTML = ICON_FLAG;
  const dateIcon = document.createElement("span");
  dateIcon.className = "ks-icon ks-date";
  dateIcon.innerHTML = ICON_CALENDAR + (sub.dueDate ? " " + formatDate(sub.dueDate) : "");
  iconsRow.append(ownerIcon, statusIcon, dateIcon);
  mini.appendChild(iconsRow);

  mini.addEventListener("click", (e) => {
    e.stopPropagation();
    openTaskDetailModal(sub, group, project, groupTasks);
  });

  return mini;
}

/* Grabbing a card (mousedown+move past a small threshold) live-moves it
   between/within kanban-card-list containers as the cursor crosses a
   neighboring card's midpoint or a different column's bounds -- mirrors the
   same "no real native drag-and-drop" approach used for group reordering,
   which proved far more reliable than HTML5 drag-and-drop in practice. A
   mousedown+mouseup with no real movement is treated as a click and opens
   the task detail modal instead. */
function startKanbanCardDrag(startEvent, dragEl, task, group, canDrag, project, groupTasks) {
  const startX = startEvent.clientX;
  const startY = startEvent.clientY;
  const THRESHOLD = 4;
  let dragging = false;

  function allColumns() {
    return Array.from(document.querySelectorAll(`.kanban-board[data-group-id="${group.id}"] .kanban-column`));
  }
  function cardsIn(colEl) {
    return Array.from(colEl.querySelector(".kanban-card-list").children);
  }

  function onMouseMove(e) {
    if (!dragging) {
      if (!canDrag) return;
      if (Math.abs(e.clientX - startX) < THRESHOLD && Math.abs(e.clientY - startY) < THRESHOLD) return;
      dragging = true;
      dragEl.classList.add("dragging");
      document.body.classList.add("task-row-dragging");
    }
    let targetCol = null;
    for (const col of allColumns()) {
      const r = col.querySelector(".kanban-card-list").getBoundingClientRect();
      if (e.clientX >= r.left && e.clientX <= r.right) { targetCol = col; break; }
    }
    if (!targetCol) return;
    const listEl = targetCol.querySelector(".kanban-card-list");
    const siblings = cardsIn(targetCol).filter(c => c !== dragEl);
    let inserted = false;
    for (const sib of siblings) {
      const r = sib.getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) {
        listEl.insertBefore(dragEl, sib);
        inserted = true;
        break;
      }
    }
    if (!inserted) listEl.appendChild(dragEl);
  }

  async function onMouseUp() {
    document.removeEventListener("mousemove", onMouseMove);
    document.removeEventListener("mouseup", onMouseUp);
    document.body.classList.remove("task-row-dragging");
    dragEl.classList.remove("dragging");
    if (!dragging) {
      openTaskDetailModal(task, group, project, groupTasks);
      return;
    }
    const newStatusId = dragEl.closest(".kanban-column").dataset.statusId;
    const statusChanged = newStatusId !== task.status;

    if (!isAdmin()) {
      if (statusChanged) {
        try { await api("PATCH", `/api/tasks/${task.id}`, { status: newStatusId }); } catch (err) { alert(err.message); }
      }
      await loadAndRenderBoard();
      return;
    }

    try {
      if (statusChanged) {
        await api("PATCH", `/api/tasks/${task.id}`, { status: newStatusId });
      }
      const topIds = [];
      allColumns().forEach(col => cardsIn(col).forEach(c => topIds.push(c.dataset.taskId)));
      await api("POST", "/api/tasks/reorder", { taskIds: topIds });
    } catch (err) { alert(err.message); }
    await loadAndRenderBoard();
  }

  document.addEventListener("mousemove", onMouseMove);
  document.addEventListener("mouseup", onMouseUp);
}

function buildKanbanSummaryRow(tasksArr, groupStatuses) {
  const row = document.createElement("div");
  row.className = "kanban-summary-row";

  const label = document.createElement("span");
  label.className = "kanban-summary-label";
  label.textContent = "Overall";
  row.appendChild(label);

  const barWrap = document.createElement("div");
  barWrap.className = "kanban-summary-bar";
  if (tasksArr.length === 0) {
    barWrap.classList.add("empty");
  } else {
    groupStatuses.forEach(s => {
      const count = tasksArr.filter(t => (groupStatuses.find(x => x.id === t.status) || groupStatuses[0]).id === s.id).length;
      if (!count) return;
      const seg = document.createElement("span");
      seg.style.width = ((count / tasksArr.length) * 100) + "%";
      seg.style.background = s.color;
      barWrap.appendChild(seg);
    });
  }
  row.appendChild(barWrap);

  const done = tasksArr.filter(t => t.status === "done").length;
  const pctText = document.createElement("span");
  pctText.className = "kanban-summary-pct";
  pctText.textContent = `${done}/${tasksArr.length}`;
  row.appendChild(pctText);

  const range = tasksArr.some(t => t.start && t.end) ? getOverallRange(tasksArr) : null;
  if (range) {
    const rangeText = document.createElement("span");
    rangeText.className = "kanban-summary-range";
    rangeText.textContent = formatDate(new Date(range.min).toISOString().slice(0, 10)) + " – " + formatDate(new Date(range.max).toISOString().slice(0, 10));
    row.appendChild(rangeText);
  }

  return row;
}

/* ---------- Task detail modal (title/status/owner/dates/subitems/updates) ---------- */
let taskDetailContext = null;

function openTaskDetailModal(task, group, project, groupTasks) {
  taskDetailContext = { taskId: task.id, groupId: group.id };
  const editable = isAdmin();
  const canEditStatus = isAdmin() || (!!me && (task.assigneeIds || []).includes(me.id));

  const titleInput = document.getElementById("td-title");
  titleInput.value = task.title;
  titleInput.disabled = !editable;

  const statusSelect = document.getElementById("td-status");
  statusSelect.innerHTML = group.statuses.map(s => `<option value="${s.id}" ${s.id === task.status ? "selected" : ""}>${escapeHtml(s.label)}</option>`).join("");
  statusSelect.disabled = !canEditStatus;

  const dueInput = document.getElementById("td-due");
  const startInput = document.getElementById("td-start");
  const endInput = document.getElementById("td-end");
  dueInput.value = task.dueDate || "";
  startInput.value = task.start || "";
  endInput.value = task.end || "";
  [dueInput, startInput, endInput].forEach(inp => inp.disabled = !editable);

  renderTdOwnerList(task, project, editable);
  renderTdSubitemsList(task, group, groupTasks);

  const notesBtn = document.getElementById("td-updates-btn");
  notesBtn.textContent = `Updates (${boardNotes.filter(n => n.taskId === task.id).length})`;

  openModal("modal-task-detail");
}

function renderTdOwnerList(task, project, editable) {
  const container = document.getElementById("td-owner-list");
  const eligible = project.memberIds.map(mid => team.find(m => m.id === mid)).filter(Boolean);
  const selected = new Set(task.assigneeIds || []);
  if (eligible.length === 0) {
    container.innerHTML = `<p class="empty-hint" style="margin:0">Assign teammates to this project first.</p>`;
    return;
  }
  container.innerHTML = eligible.map(m => `
    <label class="td-owner-item">
      <input type="checkbox" value="${m.id}" ${selected.has(m.id) ? "checked" : ""} ${editable ? "" : "disabled"}>
      ${avatarHtml(m, "margin-left:0;width:22px;height:22px;font-size:10px;border:none")}
      <span>${escapeHtml(m.name)}</span>
    </label>
  `).join("");
  if (!editable) return;
  container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener("change", async () => {
      const ids = Array.from(container.querySelectorAll('input[type="checkbox"]:checked')).map(c => c.value);
      try { await api("PATCH", `/api/tasks/${task.id}`, { assigneeIds: ids }); } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    });
  });
}

function renderTdSubitemsList(task, group, groupTasks) {
  const container = document.getElementById("td-subitems-list");
  const subitems = groupTasks.filter(t => t.parentId === task.id);
  if (subitems.length === 0) {
    container.innerHTML = `<p class="empty-hint" style="margin:4px 0">No subitems yet.</p>`;
    return;
  }
  container.innerHTML = "";
  subitems.forEach(sub => {
    const statusDef = group.statuses.find(s => s.id === sub.status) || group.statuses[0];
    const row = document.createElement("div");
    row.className = "td-subitem-row";
    row.innerHTML = `
      <span class="td-subitem-title">${escapeHtml(sub.title)}</span>
      <span class="status-pill td-subitem-status" style="background:${statusDef.color}">${escapeHtml(statusDef.label)}</span>
      ${isAdmin() ? `<button type="button" class="td-subitem-del" title="Delete subitem">&times;</button>` : ""}
    `;
    const canEditSubStatus = isAdmin() || (!!me && (sub.assigneeIds || []).includes(me.id));
    const pill = row.querySelector(".td-subitem-status");
    if (canEditSubStatus) {
      pill.addEventListener("click", (e) => {
        e.stopPropagation();
        showPopover(pill, (pop) => {
          if (isAdmin()) { pop.classList.add("status-editor"); renderStatusEditor(pop, sub, group); }
          else renderStatusPicker(pop, sub, group);
        });
      });
    } else {
      pill.classList.add("readonly");
    }
    const delBtn = row.querySelector(".td-subitem-del");
    if (delBtn) {
      delBtn.addEventListener("click", async () => {
        try { await api("DELETE", `/api/tasks/${sub.id}`); } catch (err) { alert(err.message); }
        await loadAndRenderBoard();
      });
    }
    container.appendChild(row);
  });
}

document.getElementById("td-title").addEventListener("blur", async (e) => {
  if (!taskDetailContext || !isAdmin()) return;
  const v = e.target.value.trim();
  const task = tasks.find(t => t.id === taskDetailContext.taskId);
  if (!task || !v || v === task.title) return;
  try { await api("PATCH", `/api/tasks/${taskDetailContext.taskId}`, { title: v }); } catch (err) { alert(err.message); }
  await loadAndRenderBoard();
});
document.getElementById("td-title").addEventListener("keydown", e => { if (e.key === "Enter") e.target.blur(); });

document.getElementById("td-status").addEventListener("change", async (e) => {
  if (!taskDetailContext) return;
  try { await api("PATCH", `/api/tasks/${taskDetailContext.taskId}`, { status: e.target.value }); } catch (err) { alert(err.message); }
  await loadAndRenderBoard();
});
document.getElementById("td-due").addEventListener("change", async (e) => {
  if (!taskDetailContext) return;
  try { await api("PATCH", `/api/tasks/${taskDetailContext.taskId}`, { dueDate: e.target.value }); } catch (err) { alert(err.message); }
  await loadAndRenderBoard();
});
document.getElementById("td-start").addEventListener("change", async (e) => {
  if (!taskDetailContext) return;
  try { await api("PATCH", `/api/tasks/${taskDetailContext.taskId}`, { start: e.target.value }); } catch (err) { alert(err.message); }
  await loadAndRenderBoard();
});
document.getElementById("td-end").addEventListener("change", async (e) => {
  if (!taskDetailContext) return;
  try { await api("PATCH", `/api/tasks/${taskDetailContext.taskId}`, { end: e.target.value }); } catch (err) { alert(err.message); }
  await loadAndRenderBoard();
});
document.getElementById("td-updates-btn").addEventListener("click", () => {
  if (!taskDetailContext) return;
  const task = tasks.find(t => t.id === taskDetailContext.taskId);
  if (task) openNotesModal(task);
});
document.getElementById("td-delete-btn").addEventListener("click", async () => {
  if (!taskDetailContext) return;
  if (!confirm("Delete this task and all its subitems?")) return;
  try { await api("DELETE", `/api/tasks/${taskDetailContext.taskId}`); } catch (err) { alert(err.message); }
  closeModal("modal-task-detail");
  taskDetailContext = null;
  await loadAndRenderBoard();
});
document.getElementById("td-add-subitem-input").addEventListener("keydown", async (e) => {
  if (e.key !== "Enter" || !taskDetailContext) return;
  const input = e.target;
  const title = input.value.trim();
  if (!title) return;
  try {
    await api("POST", "/api/tasks", { projectId: currentBoardProjectId, groupId: taskDetailContext.groupId, title, parentId: taskDetailContext.taskId });
  } catch (err) { alert(err.message); }
  input.value = "";
  await loadAndRenderBoard();
});

/* ---------- Task updates / notes with attachments ---------- */
async function apiUpload(url, formData) {
  const res = await fetch(url, { method: "POST", credentials: "same-origin", body: formData });
  if (res.status === 401) { showLogin(); throw new Error("Not logged in"); }
  let data = null;
  try { data = await res.json(); } catch (e) { /* no body */ }
  if (!res.ok) throw new Error((data && data.error) || "Request failed");
  return data;
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

function formatDateTime(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" }) + ", " +
    d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

function openNotesModal(task) {
  notesModalTaskId = task.id;
  document.getElementById("notes-modal-title").textContent = task.title;
  document.getElementById("notes-input").value = "";
  document.getElementById("notes-attachments").value = "";
  document.getElementById("notes-attach-preview").textContent = "";
  renderNotesList(task.id);
  openModal("modal-notes");
}

function renderNotesList(taskId) {
  const list = document.getElementById("notes-list");
  const notes = boardNotes.filter(n => n.taskId === taskId).sort((a, b) => a.createdAt - b.createdAt);
  if (notes.length === 0) {
    list.innerHTML = `<p class="empty-hint">No updates yet. Be the first to add one.</p>`;
    return;
  }
  list.innerHTML = notes.map(n => {
    const author = team.find(m => m.id === n.authorId);
    const canDelete = isAdmin() || (!!me && n.authorId === me.id);
    const attachmentsHtml = (n.attachments || []).map(a => `
      <a class="note-attachment" href="/api/notes/${n.id}/attachments/${a.id}" target="_blank" rel="noopener">
        ${ICON_PAPERCLIP} ${escapeHtml(a.originalName)} <span class="note-att-size">(${formatFileSize(a.size)})</span>
      </a>
    `).join("");
    return `
      <div class="note-item" data-note-id="${n.id}">
        <div class="note-head">
          ${avatarHtml(author || { id: n.authorId, name: "?" })}
          <div class="note-head-text">
            <span class="note-author">${escapeHtml(author ? author.name : "Former teammate")}</span>
            <span class="note-time">${formatDateTime(n.createdAt)}</span>
          </div>
          ${canDelete ? `<button type="button" class="note-del" title="Delete update">&times;</button>` : ""}
        </div>
        ${n.text ? `<div class="note-text">${escapeHtml(n.text)}</div>` : ""}
        ${attachmentsHtml ? `<div class="note-attachments">${attachmentsHtml}</div>` : ""}
      </div>
    `;
  }).join("");
  list.querySelectorAll(".note-del").forEach(btn => {
    btn.addEventListener("click", async (e) => {
      const noteEl = e.target.closest(".note-item");
      const noteId = noteEl.dataset.noteId;
      if (!confirm("Delete this update?")) return;
      try {
        await api("DELETE", `/api/notes/${noteId}`);
        boardNotes = boardNotes.filter(n => n.id !== noteId);
        renderNotesList(taskId);
        renderBoard();
      } catch (err) { alert(err.message); }
    });
  });
}

document.getElementById("notes-attachments").addEventListener("change", (e) => {
  const files = Array.from(e.target.files);
  document.getElementById("notes-attach-preview").textContent = files.length ? files.map(f => f.name).join(", ") : "";
});

document.getElementById("notes-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!notesModalTaskId) return;
  const textEl = document.getElementById("notes-input");
  const fileInput = document.getElementById("notes-attachments");
  const text = textEl.value.trim();
  const files = fileInput.files;
  if (!text && files.length === 0) return;

  const fd = new FormData();
  fd.append("text", text);
  Array.from(files).forEach(f => fd.append("attachments", f));

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const note = await apiUpload(`/api/tasks/${notesModalTaskId}/notes`, fd);
    boardNotes.push(note);
    textEl.value = "";
    fileInput.value = "";
    document.getElementById("notes-attach-preview").textContent = "";
    renderNotesList(notesModalTaskId);
    renderBoard();
  } catch (err) {
    alert(err.message);
  }
  submitBtn.disabled = false;
});

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

function buildSummaryRow(tasksArr, groupStatuses) {
  const row = document.createElement("div");
  row.className = "summary-row";
  row.innerHTML = `
    <div class="summary-cell col-task">Overall</div>
    <div class="summary-cell col-notes"></div>
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
    groupStatuses.forEach(s => {
      const count = tasksArr.filter(t => (groupStatuses.find(x => x.id === t.status) || groupStatuses[0]).id === s.id).length;
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
  const allTasksRaw = await api("GET", "/api/tasks");
  const activeProjects = projects.filter(p => (p.category || "running") !== "archived");
  const activeProjectIds = new Set(activeProjects.map(p => p.id));
  const allTasks = allTasksRaw.filter(t => activeProjectIds.has(t.projectId));

  document.getElementById("stat-projects").textContent = activeProjects.length;
  if (isAdmin()) {
    const allMembers = await api("GET", "/api/members");
    document.getElementById("stat-members").textContent = allMembers.length;
  }
  document.getElementById("stat-tasks").textContent = allTasks.length;

  const done = allTasks.filter(t => t.status === "done").length;
  const pct = allTasks.length ? Math.round((done / allTasks.length) * 100) : 0;
  document.getElementById("stat-done").textContent = pct + "%";

  renderCategoryBreakdown(activeProjects);

  const withDeadline = activeProjects
    .filter(p => p.category !== "completed" && p.deadline)
    .map(project => ({ project, tasks: allTasks.filter(t => t.projectId === project.id) }))
    .sort((a, b) => new Date(a.project.deadline) - new Date(b.project.deadline));
  const upcomingProjectsList = withDeadline.filter(r => daysUntil(r.project.deadline) >= 0);
  const overdueProjectsList = withDeadline.filter(r => daysUntil(r.project.deadline) < 0);
  renderDashDeadlineSection("dash-upcoming-list", "dash-upcoming-empty", upcomingProjectsList);
  renderDashDeadlineSection("dash-overdue-list", "dash-overdue-empty", overdueProjectsList);

  const list = document.getElementById("progress-list");
  list.innerHTML = "";

  if (activeProjects.length === 0) {
    list.innerHTML = `<p class="empty-hint">${isAdmin() ? "No projects yet. Create one from the Projects tab." : "You haven't been assigned to any projects yet."}</p>`;
    return;
  }

  activeProjects.forEach(project => {
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

function renderCategoryBreakdown(projectsArr) {
  const container = document.getElementById("category-breakdown");
  container.innerHTML = "";
  const total = projectsArr.length;

  if (total === 0) {
    container.innerHTML = '<p class="empty-hint">No projects yet.</p>';
    return;
  }

  CATEGORY_KEYS.forEach(key => {
    const count = projectsArr.filter(p => (p.category || "running") === key).length;
    const pctOf = total ? Math.round((count / total) * 100) : 0;
    const row = document.createElement("div");
    row.className = "cat-breakdown-row";
    row.innerHTML = `
      <div class="cat-breakdown-top">
        <span class="category-badge ${key}">${escapeHtml(categoryLabels[key] || key)}</span>
        <span class="cat-breakdown-count">${count}</span>
      </div>
      <div class="progress-bar-bg"><div class="progress-bar-fill cat-fill-${key}" style="width:${pctOf}%"></div></div>
    `;
    container.appendChild(row);
  });
}

function renderDashDeadlineSection(listId, emptyId, rows) {
  const container = document.getElementById(listId);
  const empty = document.getElementById(emptyId);
  if (rows.length === 0) {
    container.innerHTML = "";
    empty.style.display = "block";
    return;
  }
  empty.style.display = "none";
  container.innerHTML = projectListHtml(rows);
  attachDetailRowNav(container);
}

/* ===========================================================
   REPORTS
=========================================================== */
let reportEmployeeRows = [];
let reportProjectRows = [];
let reportOverdueTasks = [];
let reportOverdueProjectsList = [];
let reportDueSoonTasks = [];
let reportAllTasksCache = [];
let reportAllProjectsCache = [];
let reportMembersCache = [];

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const todayMid = new Date();
  todayMid.setHours(0, 0, 0, 0);
  const target = new Date(dateStr);
  if (isNaN(target)) return null;
  target.setHours(0, 0, 0, 0);
  return Math.round((target - todayMid) / 86400000);
}

function getUrgency(dateStr, isDone) {
  if (isDone) return { label: "Completed", cls: "done" };
  const days = daysUntil(dateStr);
  if (days === null) return { label: "No deadline", cls: "none" };
  if (days < 0) return { label: `Overdue ${Math.abs(days)}d`, cls: "overdue" };
  if (days === 0) return { label: "Due today", cls: "critical" };
  if (days <= 3) return { label: `${days}d left`, cls: "critical" };
  if (days <= 14) return { label: `${days}d left`, cls: "high" };
  if (days <= 30) return { label: `${days}d left`, cls: "medium" };
  return { label: `${days}d left`, cls: "low" };
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  if (isNaN(d)) return "—";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function downloadCsv(filename, header, rows) {
  const esc = v => `"${String(v == null ? "" : v).replace(/"/g, '""')}"`;
  const lines = [header, ...rows].map(r => r.map(esc).join(","));
  const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function memberNamesFor(ids) {
  if (!ids || !ids.length) return "Unassigned";
  return ids.map(id => {
    const m = reportMembersCache.find(x => x.id === id);
    return m ? m.name : "Unknown";
  }).join(", ");
}

function openReportDetail(title, subtitle, bodyHtml) {
  document.getElementById("report-detail-title").textContent = title;
  document.getElementById("report-detail-subtitle").textContent = subtitle || "";
  document.getElementById("report-detail-body").innerHTML = bodyHtml;
  attachDetailRowNav(document.getElementById("report-detail-body"), "modal-report-detail");
  openModal("modal-report-detail");
}

function attachDetailRowNav(container, closeModalId) {
  container.querySelectorAll(".report-detail-row[data-project]").forEach(row => {
    const pid = row.dataset.project;
    if (!pid) return;
    row.addEventListener("click", () => {
      if (closeModalId) closeModal(closeModalId);
      openBoard(pid);
    });
  });
}

function taskListHtml(rows) {
  if (!rows.length) return `<p class="empty-hint">Nothing here.</p>`;
  return `<div class="report-detail-list">` + rows.map(({ task, project }) => {
    const urgency = getUrgency(task.dueDate, task.status === "done");
    return `
      <div class="report-detail-row" data-project="${project ? project.id : ""}">
        <div class="rdr-main">
          <span class="rdr-title">${escapeHtml(task.title)}</span>
          <span class="rdr-sub">${project ? escapeHtml(project.name) : "—"} · ${escapeHtml(memberNamesFor(task.assigneeIds))}</span>
        </div>
        <span class="urgency-badge urgency-${urgency.cls}">${task.dueDate ? formatDate(task.dueDate) + " · " : ""}${urgency.label}</span>
      </div>
    `;
  }).join("") + `</div>`;
}

function projectListHtml(rows) {
  if (!rows.length) return `<p class="empty-hint">Nothing here.</p>`;
  return `<div class="report-detail-list">` + rows.map(({ project, tasks }) => {
    const done = tasks.filter(t => t.status === "done").length;
    const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;
    const urgency = getUrgency(project.deadline, project.category === "completed");
    return `
      <div class="report-detail-row" data-project="${project.id}">
        <div class="rdr-main">
          <span class="rdr-title">${escapeHtml(project.name)}</span>
          <span class="rdr-sub">${done}/${tasks.length} tasks done · ${pct}%</span>
        </div>
        <span class="urgency-badge urgency-${urgency.cls}">${formatDate(project.deadline)} · ${urgency.label}</span>
      </div>
    `;
  }).join("") + `</div>`;
}

function employeeProjectBreakdown(memberId) {
  const byProject = new Map();
  reportAllTasksCache.forEach(t => {
    if (!(t.assigneeIds || []).includes(memberId)) return;
    if (!byProject.has(t.projectId)) byProject.set(t.projectId, []);
    byProject.get(t.projectId).push(t);
  });
  return Array.from(byProject.entries()).map(([projectId, tks]) => {
    const project = reportAllProjectsCache.find(p => p.id === projectId);
    const done = tks.filter(t => t.status === "done").length;
    return { project, tasks: tks, done, total: tks.length, pct: tks.length ? Math.round((done / tks.length) * 100) : 0 };
  }).sort((a, b) => b.total - a.total);
}

function sortAssignedTasks(list) {
  return list.slice().sort((a, b) => {
    const ta = a.task, tb = b.task;
    if ((ta.status === "done") !== (tb.status === "done")) return ta.status === "done" ? 1 : -1;
    if (!ta.dueDate && !tb.dueDate) return 0;
    if (!ta.dueDate) return 1;
    if (!tb.dueDate) return -1;
    return new Date(ta.dueDate) - new Date(tb.dueDate);
  });
}

function openEmployeeDetail(row) {
  const breakdown = employeeProjectBreakdown(row.member.id);
  const allAssignedTasks = reportAllTasksCache
    .filter(t => (t.assigneeIds || []).includes(row.member.id))
    .map(task => ({ task, project: reportAllProjectsCache.find(p => p.id === task.projectId) }));

  const summaryHtml = `
    <div class="report-detail-summary">
      <div><span class="rds-num">${row.assignedCount}</span><span class="rds-lbl">Tasks assigned</span></div>
      <div><span class="rds-num">${row.projectCount}</span><span class="rds-lbl">Projects</span></div>
      <div><span class="rds-num">${row.rate}%</span><span class="rds-lbl">Completion rate</span></div>
      <div><span class="rds-num">${row.weekCount}/${row.monthCount}/${row.yearCount}</span><span class="rds-lbl">Done Wk/Mo/Yr</span></div>
    </div>
  `;

  const projectsPanelHtml = breakdown.length ? `<div class="report-detail-list">` + breakdown.map(b => `
      <div class="report-detail-row" data-project="${b.project ? b.project.id : ""}">
        <div class="rdr-main">
          <span class="rdr-title">${b.project ? escapeHtml(b.project.name) : "Unknown project"}</span>
          <span class="rdr-sub">${b.done}/${b.total} tasks done</span>
        </div>
        <div class="report-progress" style="min-width:110px">
          <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${b.pct}%"></div></div>
          <span class="report-progress-txt">${b.pct}%</span>
        </div>
      </div>
    `).join("") + `</div>` : `<p class="empty-hint">Not assigned to any project.</p>`;

  const projectOptions = breakdown
    .filter(b => b.project)
    .map(b => `<option value="${b.project.id}">${escapeHtml(b.project.name)}</option>`)
    .join("");

  const tasksPanelHtml = `
    <div class="report-detail-filters">
      <select id="emp-detail-project-filter">
        <option value="">All projects</option>
        ${projectOptions}
      </select>
      <select id="emp-detail-due-filter">
        <option value="">All due dates</option>
        <option value="overdue">Overdue</option>
        <option value="week">Due within 7 days</option>
        <option value="has">Has due date</option>
        <option value="none">No due date</option>
      </select>
    </div>
    <div id="emp-detail-task-list"></div>
  `;

  const bodyHtml = `
    ${summaryHtml}
    <div class="report-detail-tabs view-toggle">
      <button type="button" class="view-toggle-btn active" data-tab="projects">Projects (${row.projectCount})</button>
      <button type="button" class="view-toggle-btn" data-tab="tasks">Tasks (${row.assignedCount})</button>
    </div>
    <div id="emp-detail-projects-panel">${projectsPanelHtml}</div>
    <div id="emp-detail-tasks-panel" class="hidden">${tasksPanelHtml}</div>
  `;

  openReportDetail(
    row.member.name,
    `${row.assignedCount} task${row.assignedCount === 1 ? "" : "s"} across ${row.projectCount} project${row.projectCount === 1 ? "" : "s"}`,
    bodyHtml
  );

  const projectsPanel = document.getElementById("emp-detail-projects-panel");
  const tasksPanel = document.getElementById("emp-detail-tasks-panel");
  document.querySelectorAll(".report-detail-tabs [data-tab]").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".report-detail-tabs [data-tab]").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      const showProjects = btn.dataset.tab === "projects";
      projectsPanel.classList.toggle("hidden", !showProjects);
      tasksPanel.classList.toggle("hidden", showProjects);
    });
  });

  function applyEmployeeTaskFilters() {
    const projFilter = document.getElementById("emp-detail-project-filter").value;
    const dueFilter = document.getElementById("emp-detail-due-filter").value;
    let filtered = allAssignedTasks;
    if (projFilter) filtered = filtered.filter(({ task }) => task.projectId === projFilter);
    if (dueFilter === "overdue") {
      filtered = filtered.filter(({ task }) => task.status !== "done" && task.dueDate && daysUntil(task.dueDate) < 0);
    } else if (dueFilter === "week") {
      filtered = filtered.filter(({ task }) => {
        if (task.status === "done" || !task.dueDate) return false;
        const d = daysUntil(task.dueDate);
        return d !== null && d >= 0 && d <= 7;
      });
    } else if (dueFilter === "has") {
      filtered = filtered.filter(({ task }) => !!task.dueDate);
    } else if (dueFilter === "none") {
      filtered = filtered.filter(({ task }) => !task.dueDate);
    }
    const container = document.getElementById("emp-detail-task-list");
    container.innerHTML = taskListHtml(sortAssignedTasks(filtered));
    attachDetailRowNav(container, "modal-report-detail");
  }

  document.getElementById("emp-detail-project-filter").addEventListener("change", applyEmployeeTaskFilters);
  document.getElementById("emp-detail-due-filter").addEventListener("change", applyEmployeeTaskFilters);
  applyEmployeeTaskFilters();
}

async function renderReportPage() {
  const [allMembers, allProjects, allTasksRaw] = await Promise.all([
    api("GET", "/api/members"),
    api("GET", "/api/projects"),
    api("GET", "/api/tasks")
  ]);
  const activeProjects = allProjects.filter(p => (p.category || "running") !== "archived");
  const activeProjectIds = new Set(activeProjects.map(p => p.id));
  const allTasks = allTasksRaw.filter(t => activeProjectIds.has(t.projectId));
  reportAllTasksCache = allTasks;
  reportAllProjectsCache = activeProjects;
  reportMembersCache = allMembers;

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7 * 86400000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const yearStart = new Date(now.getFullYear(), 0, 1);

  /* ---- Alert stats ---- */
  const overdueTasks = allTasks.filter(t => t.status !== "done" && t.dueDate && daysUntil(t.dueDate) < 0).length;
  const overdueProjects = activeProjects.filter(p => p.category !== "completed" && p.deadline && daysUntil(p.deadline) < 0).length;
  const dueThisWeek = allTasks.filter(t => {
    if (t.status === "done" || !t.dueDate) return false;
    const d = daysUntil(t.dueDate);
    return d !== null && d >= 0 && d <= 7;
  }).length;
  const overallDone = allTasks.filter(t => t.status === "done").length;
  const overallRate = allTasks.length ? Math.round((overallDone / allTasks.length) * 100) : 0;

  reportOverdueTasks = allTasks
    .filter(t => t.status !== "done" && t.dueDate && daysUntil(t.dueDate) < 0)
    .map(task => ({ task, project: activeProjects.find(p => p.id === task.projectId) }))
    .sort((a, b) => new Date(a.task.dueDate) - new Date(b.task.dueDate));

  reportOverdueProjectsList = activeProjects
    .filter(p => p.category !== "completed" && p.deadline && daysUntil(p.deadline) < 0)
    .map(project => ({ project, tasks: allTasks.filter(t => t.projectId === project.id) }))
    .sort((a, b) => new Date(a.project.deadline) - new Date(b.project.deadline));

  reportDueSoonTasks = allTasks
    .filter(t => {
      if (t.status === "done" || !t.dueDate) return false;
      const d = daysUntil(t.dueDate);
      return d !== null && d >= 0 && d <= 7;
    })
    .map(task => ({ task, project: activeProjects.find(p => p.id === task.projectId) }))
    .sort((a, b) => new Date(a.task.dueDate) - new Date(b.task.dueDate));

  document.getElementById("report-overdue-tasks").textContent = overdueTasks;
  document.getElementById("report-overdue-projects").textContent = overdueProjects;
  document.getElementById("report-due-week").textContent = dueThisWeek;
  document.getElementById("report-completion-rate").textContent = overallRate + "%";

  /* ---- Employee section ---- */
  reportEmployeeRows = allMembers.map(member => {
    const assigned = allTasks.filter(t => (t.assigneeIds || []).includes(member.id));
    const projectIds = new Set(assigned.map(t => t.projectId));
    const done = assigned.filter(t => t.status === "done");
    const weekCount = done.filter(t => t.completedAt && new Date(t.completedAt) >= weekAgo).length;
    const monthCount = done.filter(t => t.completedAt && new Date(t.completedAt) >= monthStart).length;
    const yearCount = done.filter(t => t.completedAt && new Date(t.completedAt) >= yearStart).length;
    const rate = assigned.length ? Math.round((done.length / assigned.length) * 100) : 0;
    const upcoming = assigned
      .filter(t => t.status !== "done" && t.dueDate)
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate));
    const nextTask = upcoming[0] || null;
    return {
      member,
      assignedCount: assigned.length,
      projectCount: projectIds.size,
      weekCount, monthCount, yearCount,
      completedCount: done.length,
      rate,
      nextDeadline: nextTask ? nextTask.dueDate : null,
      nextTaskTitle: nextTask ? nextTask.title : null
    };
  }).sort((a, b) => b.assignedCount - a.assignedCount);

  const empBody = document.getElementById("report-employee-body");
  const empEmpty = document.getElementById("report-employee-empty");
  empBody.innerHTML = "";
  if (reportEmployeeRows.length === 0) {
    empEmpty.style.display = "block";
  } else {
    empEmpty.style.display = "none";
    reportEmployeeRows.forEach(r => {
      const urgency = getUrgency(r.nextDeadline, false);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><div class="report-person">${avatarHtml(r.member)}<span>${escapeHtml(r.member.name)}</span></div></td>
        <td>${r.assignedCount}</td>
        <td>${r.projectCount}</td>
        <td>
          <div class="report-triple">
            <div><span class="rt-num">${r.weekCount}</span><span class="rt-lbl">Wk</span></div>
            <div><span class="rt-num">${r.monthCount}</span><span class="rt-lbl">Mo</span></div>
            <div><span class="rt-num">${r.yearCount}</span><span class="rt-lbl">Yr</span></div>
          </div>
        </td>
        <td>${r.rate}%</td>
        <td>${r.nextDeadline
          ? `<span class="urgency-badge urgency-${urgency.cls}" title="${escapeHtml(r.nextTaskTitle || "")}">${formatDate(r.nextDeadline)} · ${urgency.label}</span>`
          : `<span class="urgency-badge urgency-none">No upcoming</span>`}</td>
      `;
      tr.addEventListener("click", () => openEmployeeDetail(r));
      empBody.appendChild(tr);
    });
  }

  /* ---- Project section ---- */
  reportProjectRows = activeProjects.map(project => {
    const tks = allTasks.filter(t => t.projectId === project.id);
    const doneCount = tks.filter(t => t.status === "done").length;
    const pct = tks.length ? Math.round((doneCount / tks.length) * 100) : 0;
    const isDone = project.category === "completed";
    return { project, taskCount: tks.length, doneCount, pct, isDone };
  }).sort((a, b) => {
    if (a.isDone !== b.isDone) return a.isDone ? 1 : -1;
    const av = a.project.deadline ? new Date(a.project.deadline).getTime() : Infinity;
    const bv = b.project.deadline ? new Date(b.project.deadline).getTime() : Infinity;
    return av - bv;
  });

  const projBody = document.getElementById("report-project-body");
  const projEmpty = document.getElementById("report-project-empty");
  projBody.innerHTML = "";
  if (reportProjectRows.length === 0) {
    projEmpty.style.display = "block";
  } else {
    projEmpty.style.display = "none";
    reportProjectRows.forEach(r => {
      const urgency = getUrgency(r.project.deadline, r.isDone);
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td><span class="pname">${escapeHtml(r.project.name)}</span></td>
        <td>${formatDate(r.project.deadline)}</td>
        <td><span class="urgency-badge urgency-${urgency.cls}">${urgency.label}</span></td>
        <td>
          <div class="report-progress">
            <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${r.pct}%"></div></div>
            <span class="report-progress-txt">${r.doneCount}/${r.taskCount} · ${r.pct}%</span>
          </div>
        </td>
      `;
      tr.addEventListener("click", () => openBoard(r.project.id));
      projBody.appendChild(tr);
    });
  }
}

document.getElementById("report-stat-overdue-tasks").addEventListener("click", () => {
  openReportDetail(
    "Overdue Tasks",
    `${reportOverdueTasks.length} task${reportOverdueTasks.length === 1 ? "" : "s"} past due`,
    taskListHtml(reportOverdueTasks)
  );
});

document.getElementById("report-stat-overdue-projects").addEventListener("click", () => {
  openReportDetail(
    "Overdue Projects",
    `${reportOverdueProjectsList.length} project${reportOverdueProjectsList.length === 1 ? "" : "s"} past deadline`,
    projectListHtml(reportOverdueProjectsList)
  );
});

document.getElementById("report-stat-due-week").addEventListener("click", () => {
  openReportDetail(
    "Due Within 7 Days",
    `${reportDueSoonTasks.length} task${reportDueSoonTasks.length === 1 ? "" : "s"} coming up`,
    taskListHtml(reportDueSoonTasks)
  );
});

document.getElementById("btn-export-employee-csv").addEventListener("click", () => {
  const rows = reportEmployeeRows.map(r => [
    r.member.name, r.assignedCount, r.projectCount, r.weekCount, r.monthCount, r.yearCount,
    r.rate + "%", r.nextDeadline ? formatDate(r.nextDeadline) : "—"
  ]);
  downloadCsv(
    "employee-report.csv",
    ["Employee", "Tasks Assigned", "Projects", "Completed (Week)", "Completed (Month)", "Completed (Year)", "Completion Rate", "Next Deadline"],
    rows
  );
});

document.getElementById("btn-export-project-csv").addEventListener("click", () => {
  const rows = reportProjectRows.map(r => [
    r.project.name, formatDate(r.project.deadline), getUrgency(r.project.deadline, r.isDone).label,
    `${r.doneCount}/${r.taskCount}`, r.pct + "%"
  ]);
  downloadCsv(
    "project-report.csv",
    ["Project", "Deadline", "Priority", "Tasks Done", "Completion %"],
    rows
  );
});

/* ---------- Init ---------- */
tryResume();
