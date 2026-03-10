// tasks.js — Kanban Task Dashboard

import { db } from "./firebase-config.js";
import {
  collectionGroup,
  query,
  where,
  onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import { requireAuth, signOutUser, showToast, initAdminNav } from "./auth.js";
import { api } from "./api.js";

// ── Auth guard ────────────────────────────────────────────────────────────────

const user = await requireAuth();
if (!user) throw new Error("Not authenticated");

document.getElementById("user-chip").textContent = user.displayName || user.email || "";
document.getElementById("logout-btn").addEventListener("click", () => signOutUser());
initAdminNav();

// ── State ─────────────────────────────────────────────────────────────────────

let allTasks = [];    // confirmed task state (from last save or initial load)
let meetingMeta = {}; // { meetingId: { meetingTitle, driveFileLink } }
let activeUsers = [];

// Draft mode
// pendingChanges: Map<taskId, { meetingId, fromStatus, toStatus }>
let pendingChanges = new Map();
let isDraftMode = false;
let bufferedTasks = null; // latest onSnapshot tasks received while in draft mode

// ── DOM refs ──────────────────────────────────────────────────────────────────

const loadingEl      = document.getElementById("loading");
const boardWrap      = document.getElementById("board-wrap");
const emptyEl        = document.getElementById("empty-tasks");
const searchInput    = document.getElementById("search-input");
const filterMeeting  = document.getElementById("filter-meeting");
const filterDest     = document.getElementById("filter-dest");
const sortBy         = document.getElementById("sort-by");
const toolbar        = document.querySelector(".kanban-toolbar");
const draftBar       = document.getElementById("draft-bar");
const draftLabel     = document.getElementById("draft-label");
const saveBtn        = document.getElementById("save-btn");
const discardBtn     = document.getElementById("discard-btn");
const syncLastLabel  = document.getElementById("sync-last-label");
const syncErrorBadge = document.getElementById("sync-error-badge");
const syncNowBtn     = document.getElementById("sync-now-btn");

const cols = {
  created:     document.getElementById("col-pending"),
  in_progress: document.getElementById("col-inprogress"),
  completed:   document.getElementById("col-done"),
};
const counts = {
  created:     document.getElementById("count-pending"),
  in_progress: document.getElementById("count-inprogress"),
  completed:   document.getElementById("count-done"),
};

// ── Draft mode ────────────────────────────────────────────────────────────────

function enterDraftMode() {
  isDraftMode = true;
  draftBar.hidden = false;
  toolbar.classList.add("disabled");
  updateDraftLabel();
}

function updateDraftLabel() {
  const n = pendingChanges.size;
  draftLabel.textContent = `${n} unsaved change${n !== 1 ? "s" : ""} — moves won't reach Google Tasks / Asana until you save.`;
}

async function saveChanges() {
  if (!pendingChanges.size) { exitDraftMode(); return; }

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  const failed = [];

  await Promise.all(
    [...pendingChanges.entries()].map(async ([taskId, { meetingId, toStatus }]) => {
      try {
        if (toStatus === "completed") {
          await api.completeTask(meetingId, taskId);
        } else {
          await api.updateTask(meetingId, taskId, { status: toStatus });
        }
      } catch (err) {
        failed.push({ taskId, err });
      }
    })
  );

  if (failed.length) {
    showToast(`${failed.length} task(s) failed to save — check your connection and try again.`, "error");
    // Remove the successful ones from pendingChanges so only failures remain
    for (const [taskId] of pendingChanges) {
      if (!failed.find((f) => f.taskId === taskId)) pendingChanges.delete(taskId);
    }
    saveBtn.disabled = false;
    saveBtn.textContent = "Retry failed";
    updateDraftLabel();
    return;
  }

  showToast("Changes saved");
  pendingChanges.clear();
  exitDraftMode();
}

function discardChanges() {
  pendingChanges.clear();
  exitDraftMode();
}

function exitDraftMode() {
  isDraftMode = false;
  draftBar.hidden = true;
  saveBtn.disabled = false;
  saveBtn.textContent = "Save changes";
  toolbar.classList.remove("disabled");

  // Apply any snapshot updates that arrived while we were in draft mode
  if (bufferedTasks !== null) {
    allTasks = bufferedTasks;
    bufferedTasks = null;
  }

  render();
}

saveBtn.addEventListener("click", saveChanges);
discardBtn.addEventListener("click", discardChanges);

// ── SortableJS ────────────────────────────────────────────────────────────────

function refreshCounts() {
  for (const [status, col] of Object.entries(cols)) {
    counts[status].textContent = col.querySelectorAll(".task-card").length;
  }
}

function initSortable() {
  Object.values(cols).forEach((col) => {
    Sortable.create(col, {
      group: "kanban",
      animation: 150,
      ghostClass: "sortable-ghost",
      dragClass: "sortable-drag",
      onEnd(evt) {
        const card      = evt.item;
        const newStatus = evt.to.dataset.status;
        const oldStatus = evt.from.dataset.status;
        const taskId    = card.dataset.taskId;
        const meetingId = card.dataset.meetingId;

        // No-op if dropped back in the same column
        if (newStatus === oldStatus) return;

        refreshCounts();
        recordPendingMove(card, taskId, meetingId, oldStatus, newStatus);
      },
    });
  });
}

function recordPendingMove(card, taskId, meetingId, fromStatus, toStatus) {
  // If the task had a prior pending move, preserve the original fromStatus
  const existing = pendingChanges.get(taskId);
  const originalFrom = existing ? existing.fromStatus : fromStatus;

  // If user moved it back to where it started, remove the pending entry
  if (toStatus === originalFrom) {
    pendingChanges.delete(taskId);
    card.classList.remove("has-pending");
    if (!pendingChanges.size) {
      discardChanges(); // nothing left — exit draft cleanly
      return;
    }
  } else {
    pendingChanges.set(taskId, { meetingId, fromStatus: originalFrom, toStatus });
    card.classList.add("has-pending");
  }

  if (!isDraftMode) enterDraftMode();
  else updateDraftLabel();
}

// ── Sync bar ──────────────────────────────────────────────────────────────────

function updateSyncBar(tasks) {
  // Find the most recent lastSyncedAt across all visible tasks
  let latest = null;
  let errorCount = 0;

  tasks.forEach((t) => {
    if (t.syncStatus === "sync_error") errorCount++;
    const ts = t.lastSyncedAt;
    if (ts) {
      const d = ts.toDate ? ts.toDate() : new Date(ts.seconds * 1000);
      if (!latest || d > latest) latest = d;
    }
  });

  if (latest) {
    const mins = Math.round((Date.now() - latest.getTime()) / 60000);
    syncLastLabel.textContent = mins < 1
      ? "Last synced: just now"
      : `Last synced: ${mins} min ago`;
  } else {
    syncLastLabel.textContent = "Not synced yet";
  }

  if (errorCount > 0) {
    syncErrorBadge.hidden = false;
    syncErrorBadge.textContent = `⚠ ${errorCount} task${errorCount !== 1 ? "s" : ""} with sync issues`;
  } else {
    syncErrorBadge.hidden = true;
  }
}

syncNowBtn.addEventListener("click", async () => {
  syncNowBtn.disabled = true;
  syncNowBtn.textContent = "Syncing…";
  try {
    const result = await api.syncNow();
    const total = result.synced + result.deleted + result.errors;
    showToast(`Synced ${total} task${total !== 1 ? "s" : ""}` +
      (result.errors > 0 ? ` (${result.errors} error${result.errors !== 1 ? "s" : ""})` : ""));
  } catch (err) {
    showToast("Sync failed — check your connection", "error");
  } finally {
    syncNowBtn.disabled = false;
    syncNowBtn.textContent = "Sync Now";
  }
});

// ── Rendering ─────────────────────────────────────────────────────────────────

function getViewTasks() {
  const search  = searchInput.value.toLowerCase();
  const meeting = filterMeeting.value;
  const dest    = filterDest.value;
  const sort    = sortBy.value;

  // Merge allTasks with pending status overrides
  let tasks = allTasks.map((t) => {
    const pending = pendingChanges.get(t.id);
    return pending ? { ...t, status: pending.toStatus, _hasPending: true } : t;
  });

  tasks = tasks.filter((t) => {
    const title = (t.editedTitle || t.title || "").toLowerCase();
    if (search && !title.includes(search)) return false;
    if (meeting && t.meetingId !== meeting) return false;
    if (dest) {
      const refs = t.externalRefs ?? [];
      if (!refs.some((r) => r.destination === dest)) return false;
    }
    return ["created", "in_progress", "completed"].includes(t.status);
  });

  tasks.sort((a, b) => {
    if (sort === "due") {
      const da = a.editedDueDate || a.suggestedDueDate || "";
      const db2 = b.editedDueDate || b.suggestedDueDate || "";
      if (!da && !db2) return 0;
      if (!da) return 1;
      if (!db2) return -1;
      return da < db2 ? -1 : 1;
    }
    return 0;
  });

  return tasks;
}

function render() {
  const tasks = getViewTasks();

  Object.values(cols).forEach((c) => { c.innerHTML = ""; });

  const byStatus = { created: [], in_progress: [], completed: [] };
  tasks.forEach((t) => {
    if (byStatus[t.status]) byStatus[t.status].push(t);
  });

  let totalShown = 0;
  for (const [status, list] of Object.entries(byStatus)) {
    list.forEach((task) => {
      cols[status].appendChild(buildCard(task));
      totalShown++;
    });
  }

  emptyEl.hidden = totalShown > 0 || allTasks.length > 0;
  refreshCounts();
  updateSyncBar(allTasks);
}

// Returns a sync status icon element for a task card.
function buildSyncDot(task) {
  const el = document.createElement("span");
  el.className = "sync-dot";

  switch (task.syncStatus) {
    case "synced":
      el.textContent = "✓";
      el.style.color = "#22c55e";
      el.title = "Synced";
      break;
    case "pending_sync":
      el.textContent = "⏱";
      el.style.color = "#9ca3af";
      el.title = "Waiting for sync";
      break;
    case "sync_error":
      el.textContent = "⚠";
      el.style.color = "#f59e0b";
      el.title = task.syncError ? `Sync error: ${task.syncError}` : "Sync error";
      break;
    case "external_deleted":
      el.textContent = "✕";
      el.style.color = "#ef4444";
      el.title = "Deleted in external system";
      break;
    default:
      return null; // no dot if no syncStatus yet
  }
  return el;
}

function buildCard(task) {
  const title      = task.editedTitle || task.title || "(untitled)";
  const dueStr     = task.editedDueDate || task.suggestedDueDate || null;
  const isOverdue  = dueStr && new Date(dueStr) < new Date() && task.status !== "completed";
  const meta       = meetingMeta[task.meetingId] ?? {};
  const refs       = task.externalRefs ?? [];
  const hasPending = !!pendingChanges.get(task.id);
  const isDeleted  = task.syncStatus === "external_deleted";

  const card = document.createElement("div");
  card.className = "task-card" +
    (hasPending ? " has-pending" : "") +
    (isDeleted ? " sync-deleted" : "");
  card.dataset.taskId   = task.id;
  card.dataset.meetingId = task.meetingId;

  const destBadges = refs.length
    ? refs.map((r) => {
        const cls   = r.destination === "asana" ? "badge-asana" : "badge-google";
        const label = r.destination === "asana" ? "Asana" : "Google Tasks";
        return r.externalUrl
          ? `<a href="${r.externalUrl}" target="_blank" class="task-badge ${cls}">${label}</a>`
          : `<span class="task-badge ${cls}">${label}</span>`;
      }).join("")
    : "";

  const confidenceCls   = `confidence-${task.confidence ?? "medium"}`;
  const confidenceLabel = task.confidence ?? "medium";

  const duePart = dueStr
    ? `<span class="due-date${isOverdue ? " overdue" : ""}">Due ${formatDate(dueStr)}</span>`
    : "";

  const meetingLink = meta.driveFileLink
    ? `<a href="${meta.driveFileLink}" target="_blank">${escHtml(meta.meetingTitle ?? task.meetingId)}</a>`
    : `<span>${escHtml(meta.meetingTitle ?? task.meetingId)}</span>`;

  const isCompleted = task.status === "completed";
  const actionBtn   = isCompleted
    ? `<button class="btn-icon reopen-btn">↩ Reopen</button>`
    : `<button class="btn-icon complete-btn">✓ Done</button>`;

  card.innerHTML = `
    <div class="task-card-top">
      <input class="task-title-input" value="${escAttr(title)}" readonly />
      ${destBadges}
      <span class="task-badge ${confidenceCls}">${escHtml(confidenceLabel)}</span>
    </div>
    <div class="task-meta">
      ${meetingLink}
      ${duePart}
    </div>
    <div class="task-footer">
      <span class="assignee-label">${escHtml(task.assigneeEmail ?? "")}</span>
      <div class="task-actions">
        ${actionBtn}
        <button class="btn-icon edit-btn">✏ Edit</button>
        <button class="btn-icon reassign-btn">⇄ Reassign</button>
      </div>
    </div>
  `;

  const titleInput = card.querySelector(".task-title-input");

  // Add sync status dot
  const dot = buildSyncDot(task);
  if (dot) card.appendChild(dot);

  // For external_deleted tasks: add Recreate button
  if (isDeleted) {
    const recreateBtn = document.createElement("button");
    recreateBtn.className = "recreate-btn";
    recreateBtn.textContent = "Recreate in external system";
    recreateBtn.style.cssText = "display:block;margin-top:8px;";
    recreateBtn.addEventListener("click", async (e) => {
      e.stopPropagation();
      recreateBtn.disabled = true;
      recreateBtn.textContent = "Recreating…";
      try {
        await api.recreateTask(task.meetingId, task.id);
        showToast("Task recreated in external system");
      } catch (err) {
        showToast("Error: " + err.message, "error");
        recreateBtn.disabled = false;
        recreateBtn.textContent = "Recreate in external system";
      }
    });
    card.appendChild(recreateBtn);
  }

  card.querySelector(".edit-btn").addEventListener("click", (e) => {
    e.stopPropagation();
    startEditTitle(card, task, titleInput);
  });

  if (isCompleted) {
    card.querySelector(".reopen-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api.reopenTask(task.meetingId, task.id);
        showToast("Task reopened");
      } catch (err) {
        showToast("Error: " + err.message, "error");
      }
    });
  } else {
    card.querySelector(".complete-btn").addEventListener("click", async (e) => {
      e.stopPropagation();
      try {
        await api.completeTask(task.meetingId, task.id);
        showToast("Task marked complete");
      } catch (err) {
        showToast("Error: " + err.message, "error");
      }
    });
  }

  card.querySelector(".reassign-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    await showReassignUI(card, task);
  });

  return card;
}

function startEditTitle(card, task, titleInput) {
  titleInput.removeAttribute("readonly");
  titleInput.focus();
  titleInput.select();

  const actionsEl = card.querySelector(".task-actions");
  const editBtn   = card.querySelector(".edit-btn");
  editBtn.hidden  = true;

  const saveBtn2   = document.createElement("button");
  saveBtn2.className  = "btn-icon save-title";
  saveBtn2.textContent = "Save";

  const cancelBtn2   = document.createElement("button");
  cancelBtn2.className  = "btn-icon";
  cancelBtn2.textContent = "Cancel";

  actionsEl.insertBefore(saveBtn2, editBtn);
  actionsEl.insertBefore(cancelBtn2, editBtn);

  const cleanup = () => {
    titleInput.setAttribute("readonly", "");
    saveBtn2.remove();
    cancelBtn2.remove();
    editBtn.hidden = false;
  };

  saveBtn2.addEventListener("click", async (e) => {
    e.stopPropagation();
    const newTitle = titleInput.value.trim();
    if (!newTitle) { showToast("Title cannot be empty", "error"); return; }
    try {
      await api.updateTask(task.meetingId, task.id, { title: newTitle });
      showToast("Title saved");
      cleanup();
    } catch (err) {
      showToast("Error: " + err.message, "error");
    }
  });

  cancelBtn2.addEventListener("click", (e) => {
    e.stopPropagation();
    titleInput.value = task.editedTitle || task.title || "";
    cleanup();
  });
}

async function showReassignUI(card, task) {
  if (!activeUsers.length) {
    try {
      const { users } = await api.getActiveUsers();
      activeUsers = users;
    } catch (err) {
      showToast("Could not load users: " + err.message, "error");
      return;
    }
  }

  const footer   = card.querySelector(".task-footer");
  const existing = card.querySelector(".reassign-row");
  if (existing) { existing.remove(); return; }

  const row = document.createElement("div");
  row.className  = "reassign-row";
  row.style.cssText = "margin-top:8px;display:flex;gap:6px;align-items:center;";

  const sel = document.createElement("select");
  sel.className = "reassign-select";
  activeUsers.forEach((u) => {
    const opt = document.createElement("option");
    opt.value   = u.uid;
    opt.textContent = u.displayName || u.email;
    if (u.uid === task.assigneeUid) opt.selected = true;
    sel.appendChild(opt);
  });

  const confirmBtn = document.createElement("button");
  confirmBtn.className  = "btn-icon";
  confirmBtn.textContent = "Assign";

  const cancelBtn = document.createElement("button");
  cancelBtn.className  = "btn-icon";
  cancelBtn.textContent = "Cancel";

  row.append(sel, confirmBtn, cancelBtn);
  footer.after(row);

  confirmBtn.addEventListener("click", async () => {
    const newUid = sel.value;
    if (newUid === task.assigneeUid) { row.remove(); return; }
    try {
      await api.updateTask(task.meetingId, task.id, { assigneeUid: newUid });
      showToast("Task reassigned");
      row.remove();
    } catch (err) {
      showToast("Error: " + err.message, "error");
    }
  });

  cancelBtn.addEventListener("click", () => row.remove());
}

// ── Firestore real-time listener ──────────────────────────────────────────────

function subscribeToTasks() {
  const q = query(
    collectionGroup(db, "tasks"),
    where("assigneeUid", "==", user.uid),
    where("status", "in", ["created", "in_progress", "completed"])
  );

  return onSnapshot(q, async (snap) => {
    const tasks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));

    // Fetch missing meeting meta
    const missingMeetings = [...new Set(
      tasks.map((t) => t.meetingId).filter((mid) => !meetingMeta[mid])
    )];
    if (missingMeetings.length) {
      try {
        const { tasks: enriched } = await api.getTasks();
        enriched.forEach((t) => {
          if (!meetingMeta[t.meetingId]) {
            meetingMeta[t.meetingId] = { meetingTitle: t.meetingTitle, driveFileLink: t.driveFileLink };
          }
        });
      } catch (_) { /* non-fatal */ }
    }

    if (isDraftMode) {
      // Buffer the update — don't disrupt the draft
      bufferedTasks = tasks;
      return;
    }

    allTasks = tasks;
    render();
  });
}

// ── Meeting filter population ─────────────────────────────────────────────────

function populateMeetingFilter() {
  const seen = new Set();
  filterMeeting.innerHTML = '<option value="">All meetings</option>';
  allTasks.forEach((t) => {
    if (!seen.has(t.meetingId)) {
      seen.add(t.meetingId);
      const opt = document.createElement("option");
      opt.value       = t.meetingId;
      opt.textContent = meetingMeta[t.meetingId]?.meetingTitle ?? t.meetingId;
      filterMeeting.appendChild(opt);
    }
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}
function escAttr(str) {
  return String(str).replace(/"/g,"&quot;").replace(/&/g,"&amp;");
}
function formatDate(iso) {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  try {
    const { tasks: initialTasks } = await api.getTasks();
    initialTasks.forEach((t) => {
      meetingMeta[t.meetingId] = { meetingTitle: t.meetingTitle, driveFileLink: t.driveFileLink };
    });
    allTasks = initialTasks;
  } catch (err) {
    showToast("Failed to load tasks: " + err.message, "error");
  }

  loadingEl.hidden = true;
  boardWrap.hidden = false;

  populateMeetingFilter();
  render();
  initSortable();
  subscribeToTasks();
}

[searchInput, filterMeeting, filterDest, sortBy].forEach((el) => {
  el.addEventListener("input", () => {
    if (isDraftMode) return; // ignore filter changes while in draft
    populateMeetingFilter();
    render();
  });
});

init();
