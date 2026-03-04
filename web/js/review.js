import { auth, signInWithCustomToken, waitForAuthReady, signOutUser, showToast } from "./auth.js";
import { api } from "./api.js";

const loadingEl   = document.getElementById("loading");
const errorState  = document.getElementById("error-state");
const errorMsg    = document.getElementById("error-message");
const contentEl   = document.getElementById("content");
const titleEl     = document.getElementById("meeting-title");
const driveLinkEl = document.getElementById("drive-link");
const proposalsList = document.getElementById("proposals-list");
const emptyEl     = document.getElementById("empty-state");
const approveAll  = document.getElementById("approve-all-btn");
const rejectAll   = document.getElementById("reject-all-btn");
const logoutBtn   = document.getElementById("logout-btn");
const chipEl      = document.getElementById("user-chip");

const params    = new URLSearchParams(location.search);
const tokenParam   = params.get("token");
const meetingParam = params.get("meetingId");

let currentMeetingId = null;
let proposals = [];

// ─── Boot ─────────────────────────────────────────────────────────────────────

async function boot() {
  if (tokenParam) {
    await bootFromToken(tokenParam);
  } else if (meetingParam) {
    await bootFromAuth(meetingParam);
  } else {
    showError("Missing token or meetingId. Please use the link from your email.");
  }
}

async function bootFromToken(token) {
  try {
    const result = await api.validateToken(token);
    // Sign in with the custom Firebase token returned by the server
    await signInWithCustomToken(auth, result.customToken);
    currentMeetingId = result.meetingId;
    setupHeader(auth.currentUser);
    renderPage(result.meetingTitle, result.driveFileLink, result.proposals);
  } catch (err) {
    showError(
      "This link is invalid or has already been used. " +
      "Please sign in to view your proposals: " + err.message
    );
  }
}

async function bootFromAuth(meetingId) {
  const user = await waitForAuthReady();
  if (!user) {
    window.location.href = "/?next=" + encodeURIComponent(location.href);
    return;
  }
  setupHeader(user);
  currentMeetingId = meetingId;

  try {
    const result = await api.getMeetingProposals(meetingId);
    renderPage(result.meetingTitle, result.driveFileLink, result.proposals);
  } catch (err) {
    showError("Failed to load proposals: " + err.message);
  }
}

function setupHeader(user) {
  if (user) {
    chipEl.textContent = user.displayName || user.email || "";
    logoutBtn.hidden = false;
    logoutBtn.addEventListener("click", () => signOutUser());
  }
}

// ─── Render page ───────────────────────────────────────────────────────────────

function renderPage(meetingTitle, driveFileLink, rawProposals) {
  loadingEl.hidden = true;
  contentEl.hidden = false;

  titleEl.textContent = meetingTitle || "Meeting Review";

  if (driveFileLink) {
    driveLinkEl.href = driveFileLink;
    driveLinkEl.hidden = false;
  }

  proposals = rawProposals || [];

  if (proposals.length === 0) {
    emptyEl.hidden = false;
    document.getElementById("bulk-actions").hidden = true;
    return;
  }

  proposals.forEach((p) => proposalsList.appendChild(buildCard(p)));
  updateBulkActions();
}

// ─── Card builder ──────────────────────────────────────────────────────────────

function buildCard(proposal) {
  const div = document.createElement("div");
  div.className = "proposal-card";
  div.id = `card-${proposal.id}`;
  div.dataset.id = proposal.id;
  div.dataset.status = proposal.status;

  const displayTitle = proposal.editedTitle || proposal.title || "Untitled";
  const displayDesc  = proposal.editedDescription || proposal.description || "";
  const conf         = proposal.confidence || "medium";

  let footerContent = "";
  if (proposal.status === "pending") {
    footerContent = `
      <button class="btn btn-approve" data-action="approve">Approve</button>
      <button class="btn btn-edit"    data-action="edit">Edit</button>
      <button class="btn btn-reject"  data-action="reject">Reject</button>
    `;
  } else if (proposal.status === "approved") {
    footerContent = `<span class="status-label approved">✓ Approved</span>`;
  } else if (proposal.status === "created") {
    footerContent = `<span class="status-label created">✓ Created in Google Tasks — <a href="https://tasks.google.com/" target="_blank" rel="noopener">View</a></span>`;
  } else if (proposal.status === "rejected") {
    footerContent = `<span class="status-label rejected">✗ Rejected</span>`;
  } else if (proposal.status === "failed") {
    footerContent = `
      <span class="status-label failed">✗ Failed to create in Google Tasks</span>
      <button class="btn btn-ghost" data-action="retry">Retry</button>
    `;
  } else if (proposal.status === "expired") {
    footerContent = `<span class="status-label expired">⌛ Expired</span>`;
  }

  div.innerHTML = `
    <div class="card-body">
      <div class="card-top">
        <span class="confidence confidence-${esc(conf)}">${esc(conf)}</span>
      </div>
      <div class="task-title" id="title-${proposal.id}">${esc(displayTitle)}</div>
      <div class="task-description" id="desc-${proposal.id}">${esc(displayDesc)}</div>
      ${proposal.suggestedDueDate
        ? `<div class="due-date">Suggested due: ${esc(proposal.suggestedDueDate)}</div>`
        : ""}
      ${proposal.transcriptExcerpt ? `
      <details>
        <summary class="excerpt-toggle">Show transcript excerpt</summary>
        <blockquote class="excerpt-text">${esc(proposal.transcriptExcerpt)}</blockquote>
      </details>` : ""}
    </div>
    <div class="card-footer" id="footer-${proposal.id}">
      ${footerContent}
    </div>
  `;

  // Apply visual state for already-decided proposals
  if (proposal.status === "approved" || proposal.status === "created") div.classList.add("approved");
  if (proposal.status === "rejected") div.classList.add("rejected");

  // Wire up action buttons
  div.addEventListener("click", handleCardClick);

  return div;
}

// ─── Action handlers ───────────────────────────────────────────────────────────

async function handleCardClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const card     = e.currentTarget;
  const proposalId = card.dataset.id;
  const action   = btn.dataset.action;

  if (action === "edit") {
    enterEditMode(card, proposalId);
    return;
  }

  if (action === "retry") {
    await retryTaskCreation(card, proposalId);
    return;
  }

  await applyAction(card, proposalId, action);
}

function enterEditMode(card, proposalId) {
  const titleEl = document.getElementById(`title-${proposalId}`);
  const descEl  = document.getElementById(`desc-${proposalId}`);
  const footer  = document.getElementById(`footer-${proposalId}`);

  titleEl.contentEditable = "true";
  descEl.contentEditable  = "true";
  titleEl.focus();

  footer.innerHTML = `
    <button class="btn btn-approve" data-action="save">Save &amp; Approve</button>
    <button class="btn btn-ghost"   data-action="cancel">Cancel</button>
  `;

  footer.querySelector("[data-action='save']").addEventListener("click", async () => {
    const newTitle = titleEl.textContent.trim();
    const newDesc  = descEl.textContent.trim();
    titleEl.contentEditable = "false";
    descEl.contentEditable  = "false";
    await applyAction(card, proposalId, "edited", newTitle, newDesc);
  });

  footer.querySelector("[data-action='cancel']").addEventListener("click", () => {
    titleEl.contentEditable = "false";
    descEl.contentEditable  = "false";
    // Restore original buttons
    const p = proposals.find((x) => x.id === proposalId);
    if (p) restoreFooter(card, p);
  });
}

function restoreFooter(card, proposal) {
  const footer = document.getElementById(`footer-${proposal.id}`);
  footer.innerHTML = `
    <button class="btn btn-approve" data-action="approve">Approve</button>
    <button class="btn btn-edit"    data-action="edit">Edit</button>
    <button class="btn btn-reject"  data-action="reject">Reject</button>
  `;
}

async function applyAction(card, proposalId, action, title, description) {
  const body = { status: action };
  if (title !== undefined)       body.title       = title;
  if (description !== undefined) body.description = description;

  // Disable buttons while saving
  card.querySelectorAll(".btn").forEach((b) => b.disabled = true);

  try {
    await api.updateProposal(currentMeetingId, proposalId, body);

    const finalStatus = action === "edited" ? "approved" : action;
    card.dataset.status = finalStatus;

    // Update local proposals array
    const p = proposals.find((x) => x.id === proposalId);
    if (p) {
      p.status = finalStatus;
      if (title !== undefined) p.editedTitle = title;
      if (description !== undefined) p.editedDescription = description;
    }

    if (finalStatus === "approved") {
      // Show an intermediate "Creating..." state and poll for the taskCreator result
      const footer = document.getElementById(`footer-${proposalId}`);
      footer.innerHTML = `<span class="status-label creating">⏳ Creating in Google Tasks...</span>`;
      card.classList.add("approved");
      pollForTaskCreation(card, proposalId);
    } else {
      applyCardVisual(card, finalStatus, proposalId);
    }
    updateBulkActions();
  } catch (err) {
    showToast("Failed: " + err.message, "error");
    card.querySelectorAll(".btn").forEach((b) => b.disabled = false);
  }
}

function applyCardVisual(card, status, proposalId) {
  card.classList.remove("approved", "rejected");
  if (status === "approved" || status === "created") card.classList.add("approved");
  if (status === "rejected") card.classList.add("rejected");

  const footer = document.getElementById(`footer-${proposalId}`);
  if (status === "approved") {
    footer.innerHTML = `<span class="status-label approved">✓ Approved</span>`;
  } else if (status === "created") {
    footer.innerHTML = `<span class="status-label created">✓ Created in Google Tasks — <a href="https://tasks.google.com/" target="_blank" rel="noopener">View</a></span>`;
  } else if (status === "rejected") {
    footer.innerHTML = `<span class="status-label rejected">✗ Rejected</span>`;
  } else if (status === "failed") {
    footer.innerHTML = `
      <span class="status-label failed">✗ Failed to create in Google Tasks</span>
      <button class="btn btn-ghost" data-action="retry">Retry</button>
    `;
  } else if (status === "expired") {
    footer.innerHTML = `<span class="status-label expired">⌛ Expired</span>`;
  }
}

// ─── Task creation polling ──────────────────────────────────────────────────

async function pollForTaskCreation(card, proposalId) {
  const MAX_ATTEMPTS = 20;
  const INTERVAL_MS  = 3000;
  let attempts = 0;

  const interval = setInterval(async () => {
    attempts++;
    try {
      const proposal = await api.getProposal(currentMeetingId, proposalId);
      if (proposal.status === "created" || proposal.status === "failed") {
        clearInterval(interval);
        card.dataset.status = proposal.status;
        const p = proposals.find((x) => x.id === proposalId);
        if (p) p.status = proposal.status;
        applyCardVisual(card, proposal.status, proposalId);
      }
    } catch {
      // Non-fatal — keep polling
    }
    if (attempts >= MAX_ATTEMPTS) {
      clearInterval(interval);
      // Task may still appear later; show a soft message rather than an error
      const footer = document.getElementById(`footer-${proposalId}`);
      if (footer && card.dataset.status === "approved") {
        footer.innerHTML = `<span class="status-label approved">✓ Approved — check Google Tasks shortly</span>`;
      }
    }
  }, INTERVAL_MS);
}

async function retryTaskCreation(card, proposalId) {
  const footer = document.getElementById(`footer-${proposalId}`);
  footer.innerHTML = `<span class="status-label creating">⏳ Creating in Google Tasks...</span>`;
  try {
    await api.updateProposal(currentMeetingId, proposalId, { status: "approved" });
    card.dataset.status = "approved";
    const p = proposals.find((x) => x.id === proposalId);
    if (p) p.status = "approved";
    pollForTaskCreation(card, proposalId);
  } catch (err) {
    showToast("Retry failed: " + err.message, "error");
    applyCardVisual(card, "failed", proposalId);
  }
}

// ─── Bulk actions ──────────────────────────────────────────────────────────────

approveAll.addEventListener("click", () => bulkAction("approve"));
rejectAll.addEventListener("click",  () => bulkAction("reject"));

async function bulkAction(action) {
  approveAll.disabled = true;
  rejectAll.disabled  = true;

  try {
    const { updated } = await api.bulkAction(currentMeetingId, action);
    const finalStatus = action === "approve" ? "approved" : "rejected";

    // Update all pending cards
    proposals.forEach((p) => {
      if (p.status === "pending") {
        p.status = finalStatus;
        const card = document.getElementById(`card-${p.id}`);
        if (card) applyCardVisual(card, finalStatus, p.id);
      }
    });

    showToast(`${updated} task${updated !== 1 ? "s" : ""} ${finalStatus}.`, "success");
    updateBulkActions();
  } catch (err) {
    showToast("Bulk action failed: " + err.message, "error");
    approveAll.disabled = false;
    rejectAll.disabled  = false;
  }
}

function updateBulkActions() {
  const hasPending = proposals.some((p) => p.status === "pending");
  approveAll.disabled = !hasPending;
  rejectAll.disabled  = !hasPending;
}

// ─── Error state ───────────────────────────────────────────────────────────────

function showError(msg) {
  loadingEl.hidden  = true;
  contentEl.hidden  = true;
  errorState.hidden = false;
  errorMsg.textContent = msg;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ─── Start ────────────────────────────────────────────────────────────────────

boot();
