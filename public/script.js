/* ===========================================================
   WorkFlow — Project Dashboard (multi-user, server-backed)
=========================================================== */

const COLORS = ["#5b5ff0", "#ef6a6a", "#f2b94a", "#6fcf97", "#3ec6e0", "#c46be0", "#e08a3e", "#4fbf8b"];

let me = null;
let team = [];       // {id, name} lite directory, visible to everyone logged in
let members = [];    // full roster with roles, admin only
let projects = [];
let groups = [];
let tasks = [];
let categoryLabels = { running: "Running Projects", query: "Sent to Query", completed: "Completed Projects" };
let currentBoardProjectId = null;
const expandedTasks = new Set();
const collapsedGroups = new Set();
const collapsedCategories = new Set();
const CATEGORY_KEYS = ["running", "query", "completed"];
let dragTaskId = null;
let dragGroupId = null;
let projectsViewMode = localStorage.getItem("projectsViewMode") || "grid";
let projectsFilter = "all";

function isAdmin() { return !!me && me.role === "admin"; }

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
  me = null; team = []; members = []; projects = []; groups = []; tasks = [];
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
  await showView("dashboard");
  renderSidebarTree();
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

  if (projects.length === 0) {
    empty.textContent = isAdmin() ? 'No projects yet. Click "New Project" to create your first one.' : "You haven't been assigned to any projects yet.";
    empty.style.display = "block";
    renderSidebarTree();
    return;
  }

  const filteredProjects = projectsFilter === "all"
    ? projects.filter(p => (p.category || "running") !== "archived")
    : projects.filter(p => (p.category || "running") === projectsFilter);

  if (filteredProjects.length === 0) {
    empty.textContent = `No projects in "${categoryLabels[projectsFilter] || projectsFilter}".`;
    empty.style.display = "block";
    renderSidebarTree();
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
        ${categorySelectHtml}
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
      ${categorySelectHtml}
      <div class="card-actions">${actionButtonsHtml}</div>
    `;
    attachProjectActions(row, project);
    list.appendChild(row);
  });

  renderSidebarTree();
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
        renderSidebarTree();
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

/* ---------- Sidebar project tree ---------- */
function renderSidebarTree() {
  const container = document.getElementById("sidebar-tree");
  container.innerHTML = "";

  CATEGORY_KEYS.forEach(key => {
    const catProjects = projects.filter(p => (p.category || "running") === key);
    const section = document.createElement("div");
    section.className = "tree-category";

    const head = document.createElement("div");
    head.className = "tree-category-head";
    head.addEventListener("click", () => {
      if (collapsedCategories.has(key)) collapsedCategories.delete(key);
      else collapsedCategories.add(key);
      renderSidebarTree();
    });

    const dot = document.createElement("span");
    dot.className = "tree-dot " + key;

    const chevron = document.createElement("span");
    chevron.className = "tree-chevron" + (collapsedCategories.has(key) ? " collapsed" : "");
    chevron.innerHTML = "&#9662;";

    const nameEl = document.createElement("span");
    nameEl.className = "tree-category-name";
    nameEl.textContent = categoryLabels[key] || key;
    if (isAdmin()) {
      nameEl.title = "Click to rename";
      nameEl.addEventListener("click", (e) => {
        e.stopPropagation();
        if (nameEl.querySelector("input")) return;
        const input = document.createElement("input");
        input.type = "text";
        input.value = categoryLabels[key];
        nameEl.textContent = "";
        nameEl.appendChild(input);
        input.focus();
        input.select();
        const commit = async () => {
          const v = input.value.trim();
          if (v && v !== categoryLabels[key]) {
            try {
              categoryLabels = await api("PATCH", "/api/category-labels", { [key]: v });
            } catch (err) { alert(err.message); }
          }
          renderSidebarTree();
        };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", ev => { if (ev.key === "Enter") input.blur(); });
        input.addEventListener("click", ev => ev.stopPropagation());
      });
    }

    const countEl = document.createElement("span");
    countEl.className = "tree-count";
    countEl.textContent = catProjects.length;
    countEl.title = catProjects.length + (catProjects.length === 1 ? " project" : " projects");

    head.append(dot, chevron, nameEl, countEl);
    section.appendChild(head);

    if (!collapsedCategories.has(key)) {
      const list = document.createElement("div");
      list.className = "tree-projects";
      if (catProjects.length === 0) {
        const empty = document.createElement("div");
        empty.className = "tree-empty";
        empty.textContent = "Empty";
        list.appendChild(empty);
      } else {
        catProjects.forEach(p => {
          const link = document.createElement("div");
          link.className = "tree-project-link" + (p.id === currentBoardProjectId ? " active" : "");
          link.textContent = p.name;
          link.title = p.name;
          link.addEventListener("click", () => openBoard(p.id));
          list.appendChild(link);
        });
      }
      section.appendChild(list);
    }

    container.appendChild(section);
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
    projects = await api("GET", "/api/projects");
    renderSidebarTree();
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
  renderSidebarTree();
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

  const isCollapsed = collapsedGroups.has(group.id);

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
    tbody.appendChild(buildTaskRow(task, project, groupTasks, false, group));
    const subitems = groupTasks.filter(t => t.parentId === task.id);
    if (expandedTasks.has(task.id)) {
      subitems.forEach(sub => tbody.appendChild(buildTaskRow(sub, project, groupTasks, true, group)));
      if (isAdmin()) tbody.appendChild(buildAddSubitemRow(task, group));
    }
  });

  table.appendChild(tbody);
  wrap.appendChild(table);

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

  wrap.appendChild(buildSummaryRow(groupTasks, group.statuses));

  if (groupTasks.length === 0) {
    const hint = document.createElement("p");
    hint.className = "empty-hint";
    hint.style.padding = "4px 16px 12px";
    hint.textContent = isAdmin() ? 'No tasks yet. Use "+ Add task" above to create one.' : "No tasks in this group yet.";
    wrap.appendChild(hint);
  }

  return wrap;
}

function buildTaskRow(task, project, groupTasks, isSub, group) {
  const tr = document.createElement("tr");
  tr.dataset.taskId = task.id;
  if (isSub) tr.classList.add("sub-row");

  const assigneeIds = task.assigneeIds || [];
  const assignedMembers = assigneeIds.map(id => team.find(m => m.id === id)).filter(Boolean);
  const statusDef = group.statuses.find(s => s.id === task.status) || group.statuses[0];

  const tdTask = document.createElement("td");
  tdTask.className = "cell-task";

  if (!isSub && isAdmin()) {
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.innerHTML = "&#8942;&#8942;";
    handle.title = "Drag to reorder";
    handle.addEventListener("mousedown", () => { tr.draggable = true; });
    tdTask.appendChild(handle);

    tr.addEventListener("dragstart", (e) => {
      dragTaskId = task.id;
      dragGroupId = group.id;
      tr.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    tr.addEventListener("dragend", () => {
      tr.draggable = false;
      tr.classList.remove("dragging");
      document.querySelectorAll(".drag-over-before,.drag-over-after").forEach(el => el.classList.remove("drag-over-before", "drag-over-after"));
      dragTaskId = null;
      dragGroupId = null;
    });
    tr.addEventListener("dragover", (e) => {
      if (dragTaskId === null || dragGroupId !== group.id) return;
      e.preventDefault();
      const rect = tr.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      tr.classList.toggle("drag-over-before", before);
      tr.classList.toggle("drag-over-after", !before);
    });
    tr.addEventListener("dragleave", () => {
      tr.classList.remove("drag-over-before", "drag-over-after");
    });
    tr.addEventListener("drop", async (e) => {
      e.preventDefault();
      tr.classList.remove("drag-over-before", "drag-over-after");
      const draggedId = dragTaskId;
      if (!draggedId || draggedId === task.id || dragGroupId !== group.id) return;
      const rect = tr.getBoundingClientRect();
      const before = (e.clientY - rect.top) < rect.height / 2;
      const topIds = groupTasks.filter(t => !t.parentId).map(t => t.id);
      const fromIdx = topIds.indexOf(draggedId);
      if (fromIdx > -1) topIds.splice(fromIdx, 1);
      let toIdx = topIds.indexOf(task.id);
      if (!before) toIdx += 1;
      topIds.splice(toIdx, 0, draggedId);
      try {
        await api("POST", "/api/tasks/reorder", { taskIds: topIds });
      } catch (err) { alert(err.message); }
      await loadAndRenderBoard();
    });
  }

  if (!isSub) {
    const isExpanded = expandedTasks.has(task.id);
    const toggle = document.createElement("button");
    toggle.className = "task-toggle";
    toggle.innerHTML = isExpanded ? "&#9662;" : "&#9656;";
    toggle.title = "Expand/collapse subitems";
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      if (expandedTasks.has(task.id)) expandedTasks.delete(task.id);
      else expandedTasks.add(task.id);
      renderBoard();
    });
    tdTask.appendChild(toggle);
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
  if (assignedMembers.length > 0) {
    const stack = assignedMembers.map(m => avatarHtml(m)).join("");
    const names = assignedMembers.map(m => m.name).join(", ");
    ownerCell.innerHTML = `<div class="owner-avatars">${stack}</div><span class="owner-names" title="${escapeHtml(names)}">${escapeHtml(names)}</span>`;
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
        let selected = new Set(assigneeIds);
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
        doneBtn.addEventListener("click", async () => {
          try {
            await api("PATCH", `/api/tasks/${task.id}`, { assigneeIds: Array.from(selected) });
          } catch (err) { alert(err.message); }
          closeAllPopovers();
          await loadAndRenderBoard();
        });
        pop.appendChild(doneBtn);
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

  const canEditStatus = isAdmin() || (!!me && assigneeIds.includes(me.id));
  if (canEditStatus) {
    statusPill.addEventListener("click", (e) => {
      e.stopPropagation();
      showPopover(statusPill, (pop) => {
        if (isAdmin()) {
          pop.classList.add("status-editor");
          renderStatusEditor(pop, task, group);
        } else {
          renderStatusPicker(pop, task, group);
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

function buildSummaryRow(tasksArr, groupStatuses) {
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

function openEmployeeDetail(row) {
  const breakdown = employeeProjectBreakdown(row.member.id);
  const assignedTasks = reportAllTasksCache
    .filter(t => (t.assigneeIds || []).includes(row.member.id))
    .sort((a, b) => {
      if ((a.status === "done") !== (b.status === "done")) return a.status === "done" ? 1 : -1;
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return new Date(a.dueDate) - new Date(b.dueDate);
    });

  const summaryHtml = `
    <div class="report-detail-summary">
      <div><span class="rds-num">${row.assignedCount}</span><span class="rds-lbl">Tasks assigned</span></div>
      <div><span class="rds-num">${row.projectCount}</span><span class="rds-lbl">Projects</span></div>
      <div><span class="rds-num">${row.rate}%</span><span class="rds-lbl">Completion rate</span></div>
      <div><span class="rds-num">${row.weekCount}/${row.monthCount}/${row.yearCount}</span><span class="rds-lbl">Done Wk/Mo/Yr</span></div>
    </div>
  `;

  const breakdownHtml = `
    <h3 class="report-detail-subhead">By project</h3>
    ${breakdown.length ? `<div class="report-detail-list">` + breakdown.map(b => `
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
    `).join("") + `</div>` : `<p class="empty-hint">Not assigned to any project.</p>`}
  `;

  const tasksHtml = `
    <h3 class="report-detail-subhead">All assigned tasks</h3>
    ${taskListHtml(assignedTasks.map(task => ({ task, project: reportAllProjectsCache.find(p => p.id === task.projectId) })))}
  `;

  openReportDetail(
    row.member.name,
    `${row.assignedCount} task${row.assignedCount === 1 ? "" : "s"} across ${row.projectCount} project${row.projectCount === 1 ? "" : "s"}`,
    summaryHtml + breakdownHtml + tasksHtml
  );
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
