import { auth, signInWithCustomToken, waitForAuthReady, signOutUser, showToast, initAdminNav, getUserRole } from "./auth.js";
import { api } from "./api.js";

const loadingEl      = document.getElementById("loading");
const errorState     = document.getElementById("error-state");
const errorMsg       = document.getElementById("error-message");
const contentEl      = document.getElementById("content");
const titleEl        = document.getElementById("meeting-title");
const driveLinkEl    = document.getElementById("drive-link");
const proposalsList  = document.getElementById("proposals-list");
const otherSection   = document.getElementById("other-tasks-section");
const otherList      = document.getElementById("other-tasks-list");
const otherCount     = document.getElementById("other-tasks-count");
const emptyEl        = document.getElementById("empty-state");
const approveAll     = document.getElementById("approve-all-btn");
const rejectAll      = document.getElementById("reject-all-btn");
const logoutBtn      = document.getElementById("logout-btn");
const chipEl         = document.getElementById("user-chip");

const params       = new URLSearchParams(location.search);
const tokenParam   = params.get("token");
const meetingParam = params.get("meetingId");

let currentMeetingId = null;
let ownProposals     = [];   // proposals where isOwner === true (or PM/admin acting on all)
let activeUsers      = [];   // for reassign dropdown
let isPrivilegedUser = false; // true if admin or project_manager

// Asana project picker state — populated on boot if Asana is connected
let asanaProjects        = [];   // [{ gid, name }]
let defaultAsanaProjectId = null; // from user preferences
let isAsanaConnected     = false;

// ─── Asana project loader ─────────────────────────────────────────────────────

async function loadAsanaProjects() {
  try {
    const settings = await api.getAsanaSettings();
    if (!settings.connected) return;
    isAsanaConnected = true;
    defaultAsanaProjectId = settings.asanaProjectId || null;
    if (settings.asanaWorkspaceId) {
      const result = await api.getAsanaProjects(settings.asanaWorkspaceId);
      asanaProjects = result.projects || [];
    }
  } catch {
    // Non-fatal — review page still works without the dropdown
  }
}

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
    await signInWithCustomToken(auth, result.customToken);
    currentMeetingId = result.meetingId;
    setupHeader(auth.currentUser);

    // Load Asana projects in parallel — non-blocking, best-effort
    await loadAsanaProjects();

    const action = params.get("action");
    if (action === "approve_all") {
      renderApproveAllConfirmation(result.meetingTitle, result.driveFileLink, result.proposals);
    } else {
      renderPage(result.meetingTitle, result.driveFileLink, result.proposals);
    }
  } catch (err) {
    const msg = (err.message || "").toLowerCase();
    if (msg.includes("expired")) {
      showError(
        "This approval link has expired. Sign in to your dashboard to review your pending proposals.",
        true
      );
    } else if (msg.includes("already been used")) {
      showError(
        "This link has already been used. Sign in to see the current status of your proposals.",
        true
      );
    } else {
      showError(
        "This link is invalid or has expired. Please sign in to review your proposals."
      );
    }
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

  // Check role — PM/admin can act on all proposals
  const role = await getUserRole();
  isPrivilegedUser = role === "admin" || role === "project_manager";

  // Load Asana projects in parallel — non-blocking, best-effort
  await loadAsanaProjects();

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
    initAdminNav();
  }
}

// ─── Approve-all confirmation ──────────────────────────────────────────────────

function renderApproveAllConfirmation(meetingTitle, driveFileLink, allProposals) {
  loadingEl.hidden = true;

  const pending = (allProposals || []).filter((p) => p.status === "pending");

  const confirmEl = document.createElement("div");
  confirmEl.id = "approve-all-confirm";
  confirmEl.style.cssText = "max-width:600px;margin:40px auto;padding:0 16px;";

  if (pending.length === 0) {
    confirmEl.innerHTML = `
      <div style="text-align:center;padding:48px 24px;">
        <div style="font-size:48px;margin-bottom:16px;">✓</div>
        <h2 style="margin:0 0 8px;font-size:20px;">All done!</h2>
        <p style="color:#6b7280;margin:0;">All tasks from this meeting have already been reviewed.</p>
        <a href="/dashboard" class="btn btn-primary" style="margin-top:24px;display:inline-block;">
          Go to Dashboard
        </a>
      </div>
    `;
    contentEl.parentNode.insertBefore(confirmEl, contentEl);
    return;
  }

  const projectOptions = asanaProjects.map((p) =>
    `<option value="${esc(p.gid)}"${p.gid === defaultAsanaProjectId ? " selected" : ""}>${esc(p.name)}</option>`
  ).join("");

  const taskListHtml = pending.map((p) => `
    <div style="padding:12px 0;border-bottom:1px solid #f3f4f6;">
      <div style="display:flex;align-items:flex-start;gap:12px;">
        <span class="confidence confidence-${esc(p.confidence || "medium")}" style="flex-shrink:0;">${esc(p.confidence || "medium")}</span>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:500;font-size:14px;">${esc(p.editedTitle || p.title || "Untitled")}</div>
          ${p.assigneeName
            ? `<div style="font-size:12px;color:#6b7280;">${esc(p.assigneeName)}${p.assigneeEmail ? " · " + esc(p.assigneeEmail) : ""}</div>`
            : ""}
          ${isAsanaConnected && asanaProjects.length > 0
            ? `<div style="margin-top:6px;display:flex;align-items:center;gap:8px;">
                 <label style="font-size:12px;color:#6b7280;white-space:nowrap;" for="confirm-asana-project-${esc(p.id)}">Asana Project:</label>
                 <select id="confirm-asana-project-${esc(p.id)}" style="font-size:12px;padding:2px 4px;border:1px solid #d1d5db;border-radius:4px;flex:1;min-width:0;">
                   ${projectOptions}
                 </select>
               </div>`
            : ""}
        </div>
      </div>
    </div>
  `).join("");

  confirmEl.innerHTML = `
    <div style="margin-bottom:4px;">
      <h2 style="margin:0 0 4px;font-size:20px;">${esc(meetingTitle || "Meeting Review")}</h2>
      ${driveFileLink
        ? `<a href="${esc(driveFileLink)}" target="_blank" rel="noopener"
             style="font-size:13px;color:#2563eb;text-decoration:none;">View transcript ↗</a>`
        : ""}
    </div>

    <div style="margin:20px 0;padding:16px 20px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:8px;">
      <p style="margin:0 0 6px;font-size:15px;font-weight:500;color:#166534;">
        You're about to approve all ${pending.length} pending task${pending.length !== 1 ? "s" : ""} from this meeting.
      </p>
      <p style="margin:0;font-size:13px;color:#166534;">
        Review the list below and click Confirm to approve all, or review them individually.
      </p>
    </div>

    <div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;margin-bottom:20px;">
      <div style="padding:10px 16px;background:#f9fafb;border-bottom:1px solid #e5e7eb;font-size:13px;font-weight:500;color:#374151;">
        ${pending.length} Pending Task${pending.length !== 1 ? "s" : ""}
      </div>
      <div style="padding:0 16px;">${taskListHtml}</div>
    </div>

    <div style="display:flex;gap:12px;">
      <button id="confirm-approve-all-btn" class="btn btn-approve" style="flex:1;">
        Confirm Approve All
      </button>
      <button id="review-individually-btn" class="btn btn-ghost" style="flex:1;">
        Review Individually
      </button>
    </div>

    <div id="approve-all-result" hidden
         style="margin-top:16px;text-align:center;padding:16px;background:#f0fdf4;
                border:1px solid #bbf7d0;border-radius:8px;color:#166534;font-weight:500;">
    </div>
  `;

  contentEl.parentNode.insertBefore(confirmEl, contentEl);

  document.getElementById("confirm-approve-all-btn").addEventListener("click", async () => {
    const confirmBtn = document.getElementById("confirm-approve-all-btn");
    const reviewBtn  = document.getElementById("review-individually-btn");
    confirmBtn.disabled = true;
    confirmBtn.textContent = "Approving…";
    reviewBtn.disabled = true;

    // Collect per-task Asana project overrides from the confirmation dialog
    let taskOverrides;
    if (isAsanaConnected && asanaProjects.length > 0) {
      taskOverrides = {};
      pending.forEach((p) => {
        const sel = document.getElementById(`confirm-asana-project-${p.id}`);
        if (sel && sel.value) taskOverrides[p.id] = { asanaProjectId: sel.value };
      });
      if (Object.keys(taskOverrides).length === 0) taskOverrides = undefined;
    }

    try {
      const { updated } = await api.bulkAction(currentMeetingId, "approve", taskOverrides);
      const resultEl = document.getElementById("approve-all-result");
      resultEl.textContent = `✓ ${updated} task${updated !== 1 ? "s" : ""} approved successfully.`;
      resultEl.hidden = false;
      confirmBtn.hidden = true;
      reviewBtn.hidden = true;
    } catch (err) {
      showToast("Bulk approve failed: " + err.message, "error");
      confirmBtn.disabled = false;
      confirmBtn.textContent = "Confirm Approve All";
      reviewBtn.disabled = false;
    }
  });

  document.getElementById("review-individually-btn").addEventListener("click", () => {
    // Remove action param from URL so the normal page behaves as expected
    const url = new URL(location.href);
    url.searchParams.delete("action");
    history.replaceState(null, "", url.toString());

    confirmEl.remove();
    renderPage(meetingTitle, driveFileLink, allProposals);
  });
}

// ─── Render page ───────────────────────────────────────────────────────────────

function renderPage(meetingTitle, driveFileLink, allProposals) {
  loadingEl.hidden = true;
  contentEl.hidden = false;

  titleEl.textContent = meetingTitle || "Meeting Review";

  if (driveFileLink) {
    driveLinkEl.href = driveFileLink;
    driveLinkEl.hidden = false;
  }

  // Split own vs others — server already sorted by confidence (high→medium→low)
  // PM/admin: treat ALL proposals as "own" (editable)
  const allProposalsList = allProposals || [];
  if (isPrivilegedUser) {
    ownProposals = allProposalsList;
  } else {
    ownProposals = allProposalsList.filter((p) => p.isOwner);
  }
  const others = isPrivilegedUser ? [] : allProposalsList.filter((p) => !p.isOwner);

  if (ownProposals.length === 0 && others.length === 0) {
    emptyEl.hidden = false;
    document.getElementById("bulk-actions").hidden = true;
    return;
  }

  // Render own proposals (or all proposals for PM/admin)
  if (ownProposals.length === 0) {
    document.getElementById("bulk-actions").hidden = true;
  } else {
    ownProposals.forEach((p) => proposalsList.appendChild(buildCard(p)));
    updateBulkActions();
  }

  // Render other-tasks section (regular users only)
  if (others.length > 0) {
    otherSection.hidden = false;
    otherCount.textContent = `(${others.length})`;

    // Group by assigneeEmail
    const groups = new Map();
    for (const p of others) {
      const key = p.assigneeEmail || p.assigneeName || "Unknown";
      if (!groups.has(key)) groups.set(key, { name: p.assigneeName, email: p.assigneeEmail, proposals: [] });
      groups.get(key).proposals.push(p);
    }

    for (const [, group] of groups) {
      const headerEl = document.createElement("div");
      headerEl.className = "other-assignee-header";
      headerEl.textContent = group.name
        ? `${group.name}${group.email ? " · " + group.email : ""}`
        : group.email || "Unknown";
      otherList.appendChild(headerEl);

      group.proposals.forEach((p) => otherList.appendChild(buildReadOnlyCard(p)));
    }
  }
}

// ─── Own proposal card (full actions) ──────────────────────────────────────────

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
      <button class="btn btn-ghost"   data-action="reassign">Reassign</button>
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

  const sharedNote = (proposal.sharedWith && proposal.sharedWith.length > 0)
    ? `<div class="shared-with-note">Shared with: ${esc(proposal.sharedWith.join(", "))}</div>`
    : "";

  const reassignedNote = proposal.reassignedFromName
    ? `<div class="reassigned-note">Reassigned from ${esc(proposal.reassignedFromName)}</div>`
    : "";

  div.innerHTML = `
    <div class="card-body">
      <div class="card-top">
        <span class="confidence confidence-${esc(conf)}">${esc(conf)}</span>
      </div>
      <div class="task-title" id="title-${proposal.id}">${esc(displayTitle)}</div>
      ${sharedNote}
      ${reassignedNote}
      <div class="task-description" id="desc-${proposal.id}">${esc(displayDesc)}</div>
      ${proposal.status === "pending"
        ? `<div class="due-date-row">
             <label class="due-label" for="due-${proposal.id}">Deadline:</label>
             <input type="date" id="due-${proposal.id}" class="due-input"
                    value="${esc(proposal.editedDueDate || proposal.suggestedDueDate || '')}">
           </div>
           ${isAsanaConnected && asanaProjects.length > 0
             ? `<div class="due-date-row">
                  <label class="due-label" for="asana-project-${proposal.id}">Asana Project:</label>
                  <select id="asana-project-${proposal.id}" class="due-input">
                    ${asanaProjects.map((p) =>
                      `<option value="${esc(p.gid)}"${p.gid === defaultAsanaProjectId ? " selected" : ""}>${esc(p.name)}</option>`
                    ).join("")}
                  </select>
                </div>`
             : ""}`
        : (proposal.editedDueDate || proposal.suggestedDueDate)
          ? `<div class="due-date">Due: ${esc(proposal.editedDueDate || proposal.suggestedDueDate)}</div>`
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

  if (proposal.status === "approved" || proposal.status === "created") div.classList.add("approved");
  if (proposal.status === "rejected") div.classList.add("rejected");

  div.addEventListener("click", handleCardClick);
  return div;
}

// ─── Read-only card (other attendees) ──────────────────────────────────────────

function buildReadOnlyCard(proposal) {
  const div = document.createElement("div");
  div.className = "proposal-card proposal-card--readonly";
  div.id = `card-other-${proposal.id}`;

  const displayTitle = proposal.editedTitle || proposal.title || "Untitled";
  const displayDesc  = proposal.editedDescription || proposal.description || "";
  const conf         = proposal.confidence || "medium";

  const statusLabels = {
    pending:     `<span class="status-label pending">Pending</span>`,
    approved:    `<span class="status-label approved">✓ Approved</span>`,
    rejected:    `<span class="status-label rejected">✗ Rejected</span>`,
    edited:      `<span class="status-label approved">✓ Approved (edited)</span>`,
    created:     `<span class="status-label created">✓ Created</span>`,
    in_progress: `<span class="status-label created">In progress</span>`,
    completed:   `<span class="status-label created">✓ Completed</span>`,
    expired:     `<span class="status-label expired">⌛ Expired</span>`,
    failed:      `<span class="status-label failed">✗ Failed</span>`,
  };

  const sharedNote = (proposal.sharedWith && proposal.sharedWith.length > 0)
    ? `<div class="shared-with-note">Shared with: ${esc(proposal.sharedWith.join(", "))}</div>`
    : "";

  div.innerHTML = `
    <div class="card-body">
      <div class="card-top">
        <span class="confidence confidence-${esc(conf)}">${esc(conf)}</span>
      </div>
      <div class="task-title">${esc(displayTitle)}</div>
      ${sharedNote}
      <div class="task-description">${esc(displayDesc)}</div>
      ${(proposal.editedDueDate || proposal.suggestedDueDate)
        ? `<div class="due-date">Due: ${esc(proposal.editedDueDate || proposal.suggestedDueDate)}</div>`
        : ""}
    </div>
    <div class="card-footer">
      ${statusLabels[proposal.status] || ""}
    </div>
  `;

  return div;
}

// ─── Action handlers ───────────────────────────────────────────────────────────

async function handleCardClick(e) {
  const btn = e.target.closest("[data-action]");
  if (!btn) return;

  const card      = e.currentTarget;
  const proposalId = card.dataset.id;
  const action    = btn.dataset.action;

  if (action === "edit") {
    enterEditMode(card, proposalId);
    return;
  }

  if (action === "retry") {
    await retryTaskCreation(card, proposalId);
    return;
  }

  if (action === "reassign") {
    await enterReassignMode(card, proposalId);
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
    const p = ownProposals.find((x) => x.id === proposalId);
    if (p) restoreFooter(card, p);
  });
}

function restoreFooter(card, proposal) {
  const footer = document.getElementById(`footer-${proposal.id}`);
  footer.innerHTML = `
    <button class="btn btn-approve" data-action="approve">Approve</button>
    <button class="btn btn-edit"    data-action="edit">Edit</button>
    <button class="btn btn-reject"  data-action="reject">Reject</button>
    <button class="btn btn-ghost"   data-action="reassign">Reassign</button>
  `;
}

async function enterReassignMode(card, proposalId) {
  const footer = document.getElementById(`footer-${proposalId}`);

  // Load active users if not yet fetched
  if (activeUsers.length === 0) {
    try {
      const result = await api.getActiveUsers();
      activeUsers = result.users || [];
    } catch {
      showToast("Could not load users for reassignment.", "error");
      return;
    }
  }

  const proposal = ownProposals.find((x) => x.id === proposalId);
  const currentUid = proposal?.assigneeUid;

  const options = activeUsers
    .filter((u) => u.uid !== currentUid)
    .map((u) => `<option value="${esc(u.uid)}">${esc(u.displayName || u.email)}</option>`)
    .join("");

  if (!options) {
    showToast("No other users available to reassign to.", "info");
    return;
  }

  footer.innerHTML = `
    <select id="reassign-select-${proposalId}" class="reassign-select">
      <option value="">Select new assignee…</option>
      ${options}
    </select>
    <button class="btn btn-approve" data-action="reassign-confirm">Reassign</button>
    <button class="btn btn-ghost"   data-action="reassign-cancel">Cancel</button>
  `;

  footer.querySelector("[data-action='reassign-confirm']").addEventListener("click", async () => {
    const select = document.getElementById(`reassign-select-${proposalId}`);
    const newUid = select.value;
    if (!newUid) {
      showToast("Please select an assignee.", "info");
      return;
    }
    footer.querySelectorAll(".btn").forEach((b) => b.disabled = true);
    try {
      await api.reassignProposal(currentMeetingId, proposalId, newUid);
      // Remove the card from own proposals
      const cardEl = document.getElementById(`card-${proposalId}`);
      if (cardEl) cardEl.remove();
      ownProposals = ownProposals.filter((x) => x.id !== proposalId);
      updateBulkActions();
      showToast("Task reassigned.", "success");
    } catch (err) {
      showToast("Reassign failed: " + err.message, "error");
      footer.querySelectorAll(".btn").forEach((b) => b.disabled = false);
    }
  });

  footer.querySelector("[data-action='reassign-cancel']").addEventListener("click", () => {
    const p = ownProposals.find((x) => x.id === proposalId);
    if (p) restoreFooter(card, p);
  });
}

async function applyAction(card, proposalId, action, title, description) {
  const apiStatus = action === "approve" ? "approved"
    : action === "reject"  ? "rejected"
    : action; // "edited"
  const body = { status: apiStatus };
  if (title !== undefined)       body.title       = title;
  if (description !== undefined) body.description = description;

  const dueInput = document.getElementById(`due-${proposalId}`);
  if (dueInput) {
    body.dueDate = dueInput.value || null;
    dueInput.disabled = true;
  }

  const asanaProjectSelect = document.getElementById(`asana-project-${proposalId}`);
  if (asanaProjectSelect) {
    body.asanaProjectId = asanaProjectSelect.value || defaultAsanaProjectId || undefined;
    asanaProjectSelect.disabled = true;
  }

  card.querySelectorAll(".btn").forEach((b) => b.disabled = true);

  try {
    await api.updateProposal(currentMeetingId, proposalId, body);

    const finalStatus = action === "edited" ? "approved" : apiStatus;
    card.dataset.status = finalStatus;

    const p = ownProposals.find((x) => x.id === proposalId);
    if (p) {
      p.status = finalStatus;
      if (title !== undefined) p.editedTitle = title;
      if (description !== undefined) p.editedDescription = description;
    }

    if (finalStatus === "approved") {
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
        const p = ownProposals.find((x) => x.id === proposalId);
        if (p) p.status = proposal.status;
        applyCardVisual(card, proposal.status, proposalId);
      }
    } catch {
      // Non-fatal — keep polling
    }
    if (attempts >= MAX_ATTEMPTS) {
      clearInterval(interval);
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
    const p = ownProposals.find((x) => x.id === proposalId);
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

  // Collect per-task Asana project overrides from any visible dropdowns
  let taskOverrides;
  if (action === "approve" && isAsanaConnected && asanaProjects.length > 0) {
    taskOverrides = {};
    ownProposals.filter((p) => p.status === "pending").forEach((p) => {
      const sel = document.getElementById(`asana-project-${p.id}`);
      if (sel && sel.value) taskOverrides[p.id] = { asanaProjectId: sel.value };
    });
    if (Object.keys(taskOverrides).length === 0) taskOverrides = undefined;
  }

  try {
    const { updated } = await api.bulkAction(currentMeetingId, action, taskOverrides);
    const finalStatus = action === "approve" ? "approved" : "rejected";

    ownProposals.forEach((p) => {
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
  const hasPending = ownProposals.some((p) => p.status === "pending");
  approveAll.disabled = !hasPending;
  rejectAll.disabled  = !hasPending;
}

// ─── Error state ───────────────────────────────────────────────────────────────

function showError(msg, showSignIn = false) {
  loadingEl.hidden  = true;
  contentEl.hidden  = true;
  errorState.hidden = false;
  errorMsg.textContent = msg;

  if (showSignIn) {
    const link = document.createElement("a");
    link.href = "/?next=" + encodeURIComponent("/dashboard");
    link.className = "btn btn-primary";
    link.style.marginTop = "16px";
    link.textContent = "Sign in to Dashboard";
    errorState.appendChild(link);
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

// ─── Start ────────────────────────────────────────────────────────────────────

boot();
