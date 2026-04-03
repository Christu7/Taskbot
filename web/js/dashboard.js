import { requireAuth, signOutUser, showToast, initAdminNav } from "./auth.js";
import { api } from "./api.js";
import { projectId } from "./firebase-config.js";

const loadingEl  = document.getElementById("loading");
const listEl     = document.getElementById("meetings-list");
const emptyEl    = document.getElementById("empty-state");
const chipEl     = document.getElementById("user-chip");
const connectBanner = document.getElementById("connect-banner");
const connectBtn = document.getElementById("connect-btn");
const awaitingBanner = document.getElementById("awaiting-banner");
const logoutBtn  = document.getElementById("logout-btn");
const refreshBtn = document.getElementById("refresh-btn");

// Upload transcript (.docx) elements
const uploadTranscriptBtn = document.getElementById("upload-transcript-btn");
const transcriptFileInput = document.getElementById("transcript-file-input");

// Submit transcript modal elements
const submitTranscriptBtn = document.getElementById("submit-transcript-btn");
const submitModal         = document.getElementById("submit-modal");
const modalTitle          = document.getElementById("modal-title");
const modalDate           = document.getElementById("modal-date");
const modalTranscript     = document.getElementById("modal-transcript");
const modalCharCount      = document.getElementById("modal-char-count");
const modalError          = document.getElementById("modal-error");
const modalTitleErr       = document.getElementById("modal-title-err");
const modalDateErr        = document.getElementById("modal-date-err");
const modalTranscriptErr  = document.getElementById("modal-transcript-err");
const modalCancelBtn      = document.getElementById("modal-cancel-btn");
const modalSubmitBtn      = document.getElementById("modal-submit-btn");

// ─── Boot ─────────────────────────────────────────────────────────────────────

const user = await requireAuth();
if (!user) throw new Error("not reached");

chipEl.textContent = user.displayName || user.email;

logoutBtn.addEventListener("click", () => signOutUser());
refreshBtn.addEventListener("click", loadMeetings);
initAdminNav();

connectBtn.addEventListener("click", async () => {
  const token = await user.getIdToken();
  const base = location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? `http://127.0.0.1:5001/${projectId}/us-central1`
    : `https://us-central1-${projectId}.cloudfunctions.net`;
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

// Check if any meetings are stuck waiting for AI configuration
try {
  const { count } = await api.getAwaitingCount();
  if (count > 0) {
    awaitingBanner.hidden = false;
  }
} catch {
  // Non-fatal
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

// ─── Submit Transcript Modal ───────────────────────────────────────────────────

// Set max date to today
modalDate.max = new Date().toISOString().split("T")[0];

function openModal() {
  submitModal.hidden = false;
  modalError.hidden = true;
  modalTitleErr.hidden = true;
  modalDateErr.hidden = true;
  modalTranscriptErr.hidden = true;
  modalTitle.value = "";
  modalDate.value = new Date().toISOString().split("T")[0];
  modalTranscript.value = "";
  modalCharCount.textContent = "0";
  modalSubmitBtn.disabled = false;
  modalSubmitBtn.textContent = "Process Transcript";
  modalCancelBtn.disabled = false;
  modalTitle.focus();
}

function closeModal() {
  submitModal.hidden = true;
}

// ─── Upload Transcript (.docx) ────────────────────────────────────────────────

uploadTranscriptBtn.addEventListener("click", () => {
  transcriptFileInput.value = ""; // reset so the same file can be re-selected
  transcriptFileInput.click();
});

transcriptFileInput.addEventListener("change", async () => {
  const file = transcriptFileInput.files[0];
  if (!file) return;

  if (!file.name.toLowerCase().endsWith(".docx")) {
    showToast("Only .docx files are supported. Please select a .docx file.", "error");
    return;
  }

  const meetingTitle = file.name.replace(/\.docx$/i, "");

  uploadTranscriptBtn.disabled = true;
  uploadTranscriptBtn.textContent = "Uploading…";

  try {
    await api.uploadTranscript(file, meetingTitle, "");
    showToast("Transcript uploaded and queued for processing.", "success");
  } catch (err) {
    showToast(err.message || "Could not upload transcript. Please try again.", "error");
  } finally {
    uploadTranscriptBtn.disabled = false;
    uploadTranscriptBtn.textContent = "Upload Transcript File";
  }
});

submitTranscriptBtn.addEventListener("click", openModal);
modalCancelBtn.addEventListener("click", closeModal);

// Close modal on backdrop click
submitModal.addEventListener("click", (e) => {
  if (e.target === submitModal) closeModal();
});

// Live character count
modalTranscript.addEventListener("input", () => {
  modalCharCount.textContent = modalTranscript.value.length.toLocaleString();
});

modalSubmitBtn.addEventListener("click", async () => {
  // Clear previous errors
  modalError.hidden = true;
  modalTitleErr.hidden = true;
  modalDateErr.hidden = true;
  modalTranscriptErr.hidden = true;

  const title = modalTitle.value.trim();
  const date  = modalDate.value;
  const text  = modalTranscript.value;

  // Client-side validation
  let hasError = false;
  if (!title) {
    modalTitleErr.textContent = "Meeting title is required.";
    modalTitleErr.hidden = false;
    hasError = true;
  }
  if (!date) {
    modalDateErr.textContent = "Meeting date is required.";
    modalDateErr.hidden = false;
    hasError = true;
  }
  if (text.length < 100) {
    modalTranscriptErr.textContent = "Transcript must be at least 100 characters.";
    modalTranscriptErr.hidden = false;
    hasError = true;
  } else if (text.length > 500_000) {
    modalTranscriptErr.textContent = "Transcript must not exceed 500,000 characters.";
    modalTranscriptErr.hidden = false;
    hasError = true;
  }
  if (hasError) return;

  modalSubmitBtn.disabled = true;
  modalSubmitBtn.textContent = "Submitting…";
  modalCancelBtn.disabled = true;

  try {
    await api.submitTranscript({ transcriptText: text, meetingTitle: title, meetingDate: date });
    closeModal();
    showToast(
      "Transcript submitted! Proposals will appear here once processed (usually under 1 minute).",
      "success"
    );
  } catch (err) {
    const msg = err.message ?? "Something went wrong.";
    if (msg.includes("already submitted")) {
      modalError.textContent = "You already submitted a transcript for this meeting.";
    } else if (msg.includes("5 transcripts today")) {
      modalError.textContent = "You've submitted 5 transcripts today. Try again tomorrow.";
    } else {
      modalError.textContent = "Submission failed. Please try again.";
    }
    modalError.hidden = false;
    modalSubmitBtn.disabled = false;
    modalSubmitBtn.textContent = "Process Transcript";
    modalCancelBtn.disabled = false;
  }
});
