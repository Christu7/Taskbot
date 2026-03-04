import { requireAuth, signOutUser, showToast } from "./auth.js";
import { api } from "./api.js";

const loadingEl  = document.getElementById("loading");
const listEl     = document.getElementById("meetings-list");
const emptyEl    = document.getElementById("empty-state");
const chipEl     = document.getElementById("user-chip");
const connectBanner = document.getElementById("connect-banner");
const connectBtn = document.getElementById("connect-btn");
const logoutBtn  = document.getElementById("logout-btn");
const refreshBtn = document.getElementById("refresh-btn");

// ─── Boot ─────────────────────────────────────────────────────────────────────

const user = await requireAuth();
if (!user) throw new Error("not reached");

chipEl.textContent = user.displayName || user.email;

logoutBtn.addEventListener("click", () => signOutUser());
refreshBtn.addEventListener("click", loadMeetings);

connectBtn.addEventListener("click", async () => {
  const token = await user.getIdToken();
  const base = location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? "http://127.0.0.1:5001/taskbot-fb10d/us-central1"
    : "https://us-central1-taskbot-fb10d.cloudfunctions.net";
  window.location.href = `${base}/oauthInit?token=${token}`;
});

// Check if user has valid tokens — show connect banner if not
try {
  const settings = await api.getSettings();
  if (settings.hasValidTokens === false) {
    connectBanner.hidden = false;
  }
} catch {
  // Non-fatal — just don't show banner
}

await loadMeetings();

// ─── Load meetings ─────────────────────────────────────────────────────────────

async function loadMeetings() {
  loadingEl.hidden = false;
  listEl.hidden = true;
  emptyEl.hidden = true;
  listEl.innerHTML = "";

  try {
    const { meetings } = await api.getPendingMeetings();

    loadingEl.hidden = true;

    if (!meetings || meetings.length === 0) {
      emptyEl.hidden = false;
      return;
    }

    for (const meeting of meetings) {
      listEl.appendChild(renderMeetingCard(meeting));
    }
    listEl.hidden = false;
  } catch (err) {
    loadingEl.hidden = true;
    showToast("Failed to load meetings: " + err.message, "error");
  }
}

// ─── Render meeting card ───────────────────────────────────────────────────────

function renderMeetingCard(meeting) {
  const count = meeting.proposals.length;
  const date  = formatDate(meeting.proposals[0]?.createdAt);

  const a = document.createElement("a");
  a.href = `/review?meetingId=${encodeURIComponent(meeting.meetingId)}`;
  a.className = "card meeting-card";

  a.innerHTML = `
    <div class="meeting-info">
      <div class="meeting-title">${esc(meeting.meetingTitle || meeting.meetingId)}</div>
      <div class="meeting-meta">
        ${date ? `<span>${date}</span>` : ""}
        <span class="count-badge">${count} pending</span>
      </div>
    </div>
    <div>
      <span class="btn btn-primary" style="pointer-events:none;">Review →</span>
    </div>
  `;

  return a;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts) {
  if (!ts) return "";
  let ms;
  if (typeof ts === "number") {
    ms = ts;
  } else if (typeof ts === "string") {
    ms = Date.parse(ts);
  } else if (ts._seconds !== undefined) {
    // Firebase Admin SDK serializes Timestamps as { _seconds, _nanoseconds }
    ms = ts._seconds * 1000;
  } else if (ts.seconds !== undefined) {
    ms = ts.seconds * 1000;
  }
  if (!ms || isNaN(ms)) return "";
  const date = new Date(ms);
  if (isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
