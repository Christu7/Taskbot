import { requireAuth, signOutUser, showToast, initAdminNav } from "./auth.js";
import { api } from "./api.js";

const loadingEl   = document.getElementById("loading");
const errorEl     = document.getElementById("error-state");
const emptyEl     = document.getElementById("empty-state");
const tableWrapEl = document.getElementById("table-wrap");
const tbodyEl     = document.getElementById("meetings-tbody");
const chipEl      = document.getElementById("user-chip");
const logoutBtn   = document.getElementById("logout-btn");

// ─── Boot ─────────────────────────────────────────────────────────────────────

const user = await requireAuth();
if (!user) throw new Error("not reached");

chipEl.textContent = user.displayName || user.email;
logoutBtn.addEventListener("click", () => signOutUser());
initAdminNav();

// ─── Load ──────────────────────────────────────────────────────────────────────

try {
  const { meetings } = await api.getMyMeetings();

  loadingEl.hidden = true;

  if (!meetings || meetings.length === 0) {
    emptyEl.hidden = false;
  } else {
    for (const meeting of meetings) {
      tbodyEl.appendChild(renderRow(meeting));
    }
    tableWrapEl.hidden = false;
  }
} catch (err) {
  loadingEl.hidden = true;
  errorEl.textContent = "Failed to load meetings: " + (err.message || "Unknown error");
  errorEl.hidden = false;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderRow(meeting) {
  const tr = document.createElement("tr");

  const title = meeting.meetingTitle || meeting.id;
  const date  = formatDate(meeting.detectedAt);

  tr.innerHTML = `
    <td class="meeting-title">${esc(title)}</td>
    <td class="meeting-date">${date}</td>
    <td>${statusBadge(meeting.status)}</td>
    <td class="actions-cell">
      <button class="btn btn-ghost" style="font-size:12px;padding:4px 10px;"
              data-action="insights" data-id="${esc(meeting.id)}"
              ${meeting.insightsProcessed ? "" : "disabled"}>
        View Insights
      </button>
      <button class="btn btn-ghost" style="font-size:12px;padding:4px 10px;"
              data-action="process" data-id="${esc(meeting.id)}"
              ${meeting.status === "completed" || meeting.insightsProcessed ? "disabled" : ""}>
        Process for Insights
      </button>
    </td>
  `;

  tr.querySelector("[data-action='insights']")?.addEventListener("click", () => {
    showToast("Insights view coming soon.", "");
  });

  tr.querySelector("[data-action='process']")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Processing…";
    try {
      await api.reprocessMeeting(meeting.id);
      showToast("Meeting queued for insights processing.", "success");
    } catch (err) {
      showToast("Failed to queue meeting: " + (err.message || "Unknown error"), "error");
      btn.disabled = false;
      btn.textContent = "Process for Insights";
    }
  });

  return tr;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status) {
  const cls = ["pending", "processing"].includes(status)
    ? "status-pending"
    : status === "proposed"   ? "status-proposed"
    : status === "completed"  ? "status-completed"
    : status === "failed"     ? "status-failed"
    : "status-unknown";
  return `<span class="status-badge ${cls}">${esc(status ?? "unknown")}</span>`;
}

function formatDate(ts) {
  if (!ts) return "—";
  let ms;
  if (typeof ts === "number") {
    ms = ts;
  } else if (typeof ts === "string") {
    ms = Date.parse(ts);
  } else if (ts._seconds !== undefined) {
    ms = ts._seconds * 1000;
  } else if (ts.seconds !== undefined) {
    ms = ts.seconds * 1000;
  }
  if (!ms || isNaN(ms)) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
