import { requireAuth, signOutUser, showToast, initAdminNav } from "./auth.js";
import { api } from "./api.js";
import { projectId } from "./firebase-config.js";

/**
 * Normalises a stored preference value into a string array.
 * `bothExpansion` is the array to use when the legacy "both" string is found.
 * Examples:
 *   normalizeArray("both",  ["email","slack"])       → ["email","slack"]
 *   normalizeArray("email", ["email","slack"])        → ["email"]
 *   normalizeArray(["email","slack"], [...])          → ["email","slack"]  (pass-through)
 */
function normalizeArray(val, bothExpansion) {
  if (Array.isArray(val)) return val;
  if (val === "both") return bothExpansion;
  if (typeof val === "string") return [val];
  return [bothExpansion[0]]; // safe fallback to first option
}

const loadingEl          = document.getElementById("loading");
const contentEl          = document.getElementById("content");
const chipEl             = document.getElementById("user-chip");
const logoutBtn          = document.getElementById("logout-btn");
const reconnectBtn       = document.getElementById("reconnect-btn");
const accountEmail       = document.getElementById("account-email");
const tokenStatus        = document.getElementById("token-status");
const isActiveEl         = document.getElementById("is-active");
const autoApproveEl      = document.getElementById("auto-approve");
const expiryEl           = document.getElementById("expiry-hours");
const saveBtn            = document.getElementById("save-btn");

// Asana elements
const asanaStatusEl      = document.getElementById("asana-status");
const connectAsanaBtn    = document.getElementById("connect-asana-btn");
const disconnectAsanaBtn = document.getElementById("disconnect-asana-btn");
const asanaConfigEl      = document.getElementById("asana-config");
const asanaWorkspaceEl   = document.getElementById("asana-workspace");
const asanaProjectEl     = document.getElementById("asana-project");
const saveAsanaBtn       = document.getElementById("save-asana-btn");
const destWarningEl      = document.getElementById("dest-warning");

// Slack elements
const slackStatusEl      = document.getElementById("slack-status");
const connectSlackBtn    = document.getElementById("connect-slack-btn");
const disconnectSlackBtn = document.getElementById("disconnect-slack-btn");
const notifySlackWarning = document.getElementById("notify-slack-warning");
const slackEmailRow      = document.getElementById("slack-email-row");
const slackEmailInput    = document.getElementById("slack-email-input");
const confirmSlackBtn    = document.getElementById("confirm-slack-btn");
const cancelSlackBtn     = document.getElementById("cancel-slack-btn");

// ─── Boot ─────────────────────────────────────────────────────────────────────

const user = await requireAuth();
if (!user) throw new Error("not reached");

chipEl.textContent = user.displayName || user.email;
logoutBtn.addEventListener("click", () => signOutUser());
initAdminNav();

reconnectBtn.addEventListener("click", async () => {
  const token = await user.getIdToken();
  const base = location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? `http://127.0.0.1:5001/${projectId}/us-central1`
    : `https://us-central1-${projectId}.cloudfunctions.net`;
  window.location.href = `${base}/oauthInit?token=${token}`;
});

connectAsanaBtn.addEventListener("click", async () => {
  const token = await user.getIdToken();
  window.location.href = `/api/auth/asana?token=${token}`;
});

disconnectAsanaBtn.addEventListener("click", async () => {
  disconnectAsanaBtn.disabled = true;
  disconnectAsanaBtn.textContent = "Disconnecting…";
  try {
    await api.disconnectAsana();
    showToast("Asana disconnected.", "success");
    await loadAsanaSettings();
  } catch (err) {
    showToast("Failed to disconnect: " + err.message, "error");
  } finally {
    disconnectAsanaBtn.disabled = false;
    disconnectAsanaBtn.textContent = "Disconnect";
  }
});

saveBtn.addEventListener("click", saveSettings);
saveAsanaBtn.addEventListener("click", saveAsanaConfig);

connectSlackBtn.addEventListener("click", () => {
  slackEmailInput.value = user.email || "";
  slackEmailRow.hidden = false;
  connectSlackBtn.hidden = true;
  slackEmailInput.focus();
});

cancelSlackBtn.addEventListener("click", () => {
  slackEmailRow.hidden = true;
  connectSlackBtn.hidden = false;
});

confirmSlackBtn.addEventListener("click", async () => {
  const email = slackEmailInput.value.trim();
  if (!email) { showToast("Enter your Slack email address.", "error"); return; }

  confirmSlackBtn.disabled = true;
  confirmSlackBtn.textContent = "Connecting…";
  try {
    await api.connectSlack(email);
    slackEmailRow.hidden = true;
    showToast("Slack connected!", "success");
    await loadSlackSettings();
  } catch (err) {
    showToast("Failed to connect Slack: " + err.message, "error");
  } finally {
    confirmSlackBtn.disabled = false;
    confirmSlackBtn.textContent = "Connect";
  }
});

disconnectSlackBtn.addEventListener("click", async () => {
  disconnectSlackBtn.disabled = true;
  disconnectSlackBtn.textContent = "Disconnecting…";
  try {
    await api.disconnectSlack();
    showToast("Slack disconnected.", "success");
    await loadSlackSettings();
  } catch (err) {
    showToast("Failed to disconnect: " + err.message, "error");
  } finally {
    disconnectSlackBtn.disabled = false;
    disconnectSlackBtn.textContent = "Disconnect";
  }
});

await loadSettings();
await loadAsanaSettings();
await loadSlackSettings();

// Show Asana connected banner if redirected back from OAuth
if (new URLSearchParams(location.search).get("asana") === "connected") {
  showToast("Asana connected! Select a workspace and project below.", "success");
  history.replaceState(null, "", location.pathname);
}

// ─── Load settings ─────────────────────────────────────────────────────────────

async function loadSettings() {
  loadingEl.hidden = false;
  contentEl.hidden = true;

  try {
    const settings = await api.getSettings();

    // Account
    accountEmail.textContent = settings.email || user.email || "";

    if (settings.hasValidTokens) {
      tokenStatus.innerHTML =
        `<span class="token-ok">✓</span> Google Account connected`;
      tokenStatus.className = "token-status token-ok";
    } else {
      tokenStatus.innerHTML =
        `<span class="token-error">✗</span> Google Account not connected — click Reconnect`;
      tokenStatus.className = "token-status token-error";
    }

    // Preferences
    isActiveEl.checked    = settings.isActive !== false;
    autoApproveEl.checked = settings.preferences?.autoApprove === true;

    const expiry = settings.preferences?.proposalExpiryHours ?? 48;
    const match = expiryEl.querySelector(`option[value="${expiry}"]`);
    if (match) match.selected = true;

    // Task destination checkboxes (normalise legacy string → array)
    const dest = normalizeArray(settings.preferences?.taskDestination, ["google_tasks", "asana"]);
    for (const cb of document.querySelectorAll("input[name=\"task-dest\"]")) {
      cb.checked = dest.includes(cb.value);
    }

    // Notification channel checkboxes (normalise legacy string → array)
    const notifyVia = normalizeArray(settings.preferences?.notifyVia, ["email", "slack"]);
    for (const cb of document.querySelectorAll("input[name=\"notify-via\"]")) {
      cb.checked = notifyVia.includes(cb.value);
    }

    // ── Integration availability warnings ──────────────────────────────────
    const avail = settings.availableIntegrations ?? {};

    // Asana: if not configured org-wide, grey out the Asana section
    const asanaSectionEl = document.getElementById("asana-section");
    const asanaNotConfiguredEl = document.getElementById("asana-not-configured");
    if (asanaSectionEl && asanaNotConfiguredEl) {
      if (!avail.asana) {
        asanaSectionEl.style.opacity = "0.5";
        asanaSectionEl.style.pointerEvents = "none";
        asanaNotConfiguredEl.hidden = false;
      } else {
        asanaSectionEl.style.opacity = "";
        asanaSectionEl.style.pointerEvents = "";
        asanaNotConfiguredEl.hidden = true;
      }
    }

    // Slack: if not configured org-wide, show a warning when Slack notify is selected
    const slackNotConfiguredEl = document.getElementById("slack-not-configured");
    if (slackNotConfiguredEl) {
      slackNotConfiguredEl.hidden = avail.slack !== false;
    }

    loadingEl.hidden = true;
    contentEl.hidden = false;
  } catch (err) {
    loadingEl.hidden = true;
    showToast("Failed to load settings: " + err.message, "error");
  }
}

// ─── Save settings ─────────────────────────────────────────────────────────────

async function saveSettings() {
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";

  try {
    const selectedDest = [...document.querySelectorAll("input[name=\"task-dest\"]:checked")]
      .map((cb) => cb.value);
    const selectedNotify = [...document.querySelectorAll("input[name=\"notify-via\"]:checked")]
      .map((cb) => cb.value);

    // Require at least one selection in each group
    if (!selectedDest.length) { showToast("Select at least one task destination.", "error"); return; }
    if (!selectedNotify.length) { showToast("Select at least one notification channel.", "error"); return; }

    await api.updateSettings({
      isActive: isActiveEl.checked,
      preferences: {
        autoApprove: autoApproveEl.checked,
        proposalExpiryHours: parseInt(expiryEl.value, 10),
        taskDestination: selectedDest,
        notifyVia: selectedNotify,
      },
    });
    showToast("Settings saved.", "success");
  } catch (err) {
    showToast("Failed to save: " + err.message, "error");
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save Changes";
  }
}

// ─── Asana connection ──────────────────────────────────────────────────────────

async function loadAsanaSettings() {
  try {
    const data = await api.getAsanaSettings();

    if (data.connected) {
      asanaStatusEl.innerHTML = "<span class=\"token-ok\">✓</span> Connected";
      asanaStatusEl.className = "setting-desc token-ok";
      connectAsanaBtn.hidden = true;
      disconnectAsanaBtn.hidden = false;
      asanaConfigEl.hidden = false;

      // Load workspaces into dropdown
      await loadAsanaWorkspaces(data.asanaWorkspaceId, data.asanaProjectId);
    } else {
      asanaStatusEl.innerHTML = "<span class=\"token-error\">✗</span> Not connected";
      asanaStatusEl.className = "setting-desc token-error";
      connectAsanaBtn.hidden = false;
      disconnectAsanaBtn.hidden = true;
      asanaConfigEl.hidden = true;
    }

    // Update destination warning visibility
    updateDestWarning(data.connected);

    // Re-check warning whenever destination radio changes
    for (const radio of document.querySelectorAll("input[name=\"task-dest\"]")) {
      radio.addEventListener("change", () => updateDestWarning(data.connected));
    }
  } catch (err) {
    asanaStatusEl.textContent = "Could not load Asana status.";
    connectAsanaBtn.hidden = false;
  }
}

function updateDestWarning(asanaConnected) {
  const asanaChecked = !!document.querySelector("input[name=\"task-dest\"][value=\"asana\"]:checked");
  destWarningEl.hidden = !(asanaChecked && !asanaConnected);
}

async function loadAsanaWorkspaces(savedWorkspaceId, savedProjectId) {
  try {
    const { workspaces } = await api.getAsanaWorkspaces();

    asanaWorkspaceEl.innerHTML = "<option value=\"\">Select a workspace…</option>";
    for (const ws of workspaces) {
      const opt = document.createElement("option");
      opt.value = ws.gid;
      opt.textContent = ws.name;
      if (ws.gid === savedWorkspaceId) opt.selected = true;
      asanaWorkspaceEl.appendChild(opt);
    }

    asanaWorkspaceEl.addEventListener("change", async () => {
      await loadAsanaProjects(asanaWorkspaceEl.value, null);
    });

    // Load projects for the currently saved workspace
    if (savedWorkspaceId) {
      await loadAsanaProjects(savedWorkspaceId, savedProjectId);
    }
  } catch (err) {
    asanaWorkspaceEl.innerHTML = "<option value=\"\">Failed to load</option>";
    showToast("Could not load Asana workspaces: " + err.message, "error");
  }
}

async function loadAsanaProjects(workspaceId, savedProjectId) {
  if (!workspaceId) {
    asanaProjectEl.innerHTML = "<option value=\"\">Select a workspace first</option>";
    asanaProjectEl.disabled = true;
    return;
  }

  asanaProjectEl.innerHTML = "<option value=\"\">Loading…</option>";
  asanaProjectEl.disabled = true;

  try {
    const { projects } = await api.getAsanaProjects(workspaceId);

    asanaProjectEl.innerHTML = "<option value=\"\">Select a project…</option>";
    for (const proj of projects) {
      const opt = document.createElement("option");
      opt.value = proj.gid;
      opt.textContent = proj.name;
      if (proj.gid === savedProjectId) opt.selected = true;
      asanaProjectEl.appendChild(opt);
    }
    asanaProjectEl.disabled = false;
  } catch (err) {
    asanaProjectEl.innerHTML = "<option value=\"\">Failed to load</option>";
    showToast("Could not load Asana projects: " + err.message, "error");
  }
}

async function saveAsanaConfig() {
  const workspaceId = asanaWorkspaceEl.value;
  const projectId = asanaProjectEl.value;

  if (!workspaceId || !projectId) {
    showToast("Select both a workspace and a project.", "error");
    return;
  }

  saveAsanaBtn.disabled = true;
  saveAsanaBtn.textContent = "Saving…";
  try {
    await api.updateSettings({
      preferences: {
        asanaWorkspaceId: workspaceId,
        asanaProjectId: projectId,
      },
    });
    showToast("Asana project saved.", "success");
  } catch (err) {
    showToast("Failed to save Asana settings: " + err.message, "error");
  } finally {
    saveAsanaBtn.disabled = false;
    saveAsanaBtn.textContent = "Save Asana Settings";
  }
}

// ─── Slack connection ──────────────────────────────────────────────────────────

async function loadSlackSettings() {
  try {
    const data = await api.getSlackSettings();

    if (data.connected) {
      slackStatusEl.innerHTML = "<span class=\"token-ok\">✓</span> Connected";
      slackStatusEl.className = "setting-desc token-ok";
      connectSlackBtn.hidden = true;
      disconnectSlackBtn.hidden = false;
    } else {
      slackStatusEl.innerHTML = "<span class=\"token-error\">✗</span> Not connected";
      slackStatusEl.className = "setting-desc token-error";
      connectSlackBtn.hidden = false;
      disconnectSlackBtn.hidden = true;
      slackEmailRow.hidden = true;
    }

    updateNotifyWarning(data.connected);

    // Toast if Slack is selected for notifications but not connected
    const currentNotifyVia = normalizeArray(data.notifyVia, ["email", "slack"]);
    if (!data.connected && currentNotifyVia.includes("slack")) {
      showToast(
        "Slack is selected for notifications but not connected. Connect Slack above or switch to Email.",
        "error"
      );
    }

    for (const radio of document.querySelectorAll("input[name=\"notify-via\"]")) {
      radio.addEventListener("change", () => updateNotifyWarning(data.connected));
    }
  } catch (err) {
    slackStatusEl.textContent = "Could not load Slack status.";
    connectSlackBtn.hidden = false;
  }
}

function updateNotifyWarning(slackConnected) {
  const slackChecked = !!document.querySelector("input[name=\"notify-via\"][value=\"slack\"]:checked");
  notifySlackWarning.hidden = !(slackChecked && !slackConnected);
}

// ─── Scan Drive history (preview → select → process) ──────────────────────────

const scanHistoryBtn     = document.getElementById("scan-history-btn");
const scanFromEl         = document.getElementById("scan-from-date");
const scanToEl           = document.getElementById("scan-to-date");
const scanDateErrorEl    = document.getElementById("scan-date-error");
const scanStatusEl       = document.getElementById("scan-status");
const scanResultsEl      = document.getElementById("scan-results");
const scanResultsListEl  = document.getElementById("scan-results-list");
const scanResultsCountEl = document.getElementById("scan-results-count");
const scanSelectAllEl    = document.getElementById("scan-select-all");
const processSelectedBtn = document.getElementById("process-selected-btn");
const processAllBtn      = document.getElementById("process-all-btn");
const processStatusEl    = document.getElementById("process-status");
const batchWarningEl     = document.getElementById("batch-warning");

// State
let scanResults = []; // { id, title, date, source, driveFileLink, alreadyProcessed }
const selectedIds = new Set();

// Default range: last 30 days (uses local browser date)
(function initDateRange() {
  const now = new Date();
  const localToday = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  const localFrom = `${from.getFullYear()}-${String(from.getMonth() + 1).padStart(2, "0")}-${String(from.getDate()).padStart(2, "0")}`;
  scanToEl.value   = localToday;
  scanFromEl.value = localFrom;
})();

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function showDateError(msg) {
  scanDateErrorEl.textContent = msg;
  scanDateErrorEl.hidden = false;
}

function clearDateError() {
  scanDateErrorEl.hidden = true;
  scanDateErrorEl.textContent = "";
}

const BATCH_WARN_THRESHOLD = 20;

function updateSelectionState() {
  const newMeetings = scanResults.filter(m => !m.alreadyProcessed);
  const selectedCount = newMeetings.filter(m => selectedIds.has(m.id)).length;

  processSelectedBtn.disabled = selectedCount === 0;
  processSelectedBtn.textContent = selectedCount > 0
    ? `Process selected (${selectedCount})`
    : "Process selected";
  processAllBtn.disabled = newMeetings.length === 0;

  const allNewSelected = newMeetings.length > 0 && newMeetings.every(m => selectedIds.has(m.id));
  scanSelectAllEl.checked = allNewSelected;
  scanSelectAllEl.indeterminate = !allNewSelected && selectedCount > 0;

  // Large-batch warning: trigger on selected count, or on all-new count when nothing selected
  const relevantCount = selectedCount > 0 ? selectedCount : newMeetings.length;
  if (relevantCount >= BATCH_WARN_THRESHOLD) {
    batchWarningEl.textContent = "Warning: processing many meetings may consume significant AI tokens.";
    batchWarningEl.hidden = false;
  } else {
    batchWarningEl.hidden = true;
  }
}

function setRowCheckboxesDisabled(disabled) {
  scanSelectAllEl.disabled = disabled;
  for (const cb of scanResultsListEl.querySelectorAll("input[type=\"checkbox\"]")) {
    // When re-enabling, keep already-processed rows disabled
    cb.disabled = disabled ? true : cb.dataset.alreadyProcessed === "1";
  }
}

function renderScanResults() {
  const newMeetings = scanResults.filter(m => !m.alreadyProcessed);
  scanResultsCountEl.textContent = `${scanResults.length} found · ${newMeetings.length} new`;

  scanResultsListEl.innerHTML = "";
  if (scanResults.length === 0) {
    scanResultsListEl.innerHTML =
      '<div style="padding:16px;text-align:center;color:#6b7280;">No meetings found in this date range.</div>';
    updateSelectionState();
    return;
  }

  for (const meeting of scanResults) {
    const row = document.createElement("div");
    row.style.cssText =
      "display:flex;align-items:center;gap:12px;padding:8px 12px;" +
      "border-bottom:1px solid #f3f4f6;";

    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.disabled = meeting.alreadyProcessed;
    cb.checked = selectedIds.has(meeting.id);
    cb.dataset.alreadyProcessed = meeting.alreadyProcessed ? "1" : "";
    cb.addEventListener("change", () => {
      if (cb.checked) selectedIds.add(meeting.id);
      else selectedIds.delete(meeting.id);
      updateSelectionState();
    });

    const titleSpan = document.createElement("span");
    titleSpan.textContent = meeting.title || meeting.id;
    titleSpan.style.flex = "1";
    if (meeting.driveFileLink) {
      const a = document.createElement("a");
      a.href = meeting.driveFileLink;
      a.target = "_blank";
      a.rel = "noopener";
      a.textContent = meeting.title || meeting.id;
      a.style.color = "inherit";
      titleSpan.textContent = "";
      titleSpan.appendChild(a);
    }

    const dateSpan = document.createElement("span");
    dateSpan.textContent = formatDate(meeting.date);
    dateSpan.style.cssText = "color:#6b7280;min-width:100px;";

    const sourceSpan = document.createElement("span");
    sourceSpan.textContent = meeting.source === "gmail_gemini_notes" ? "Gemini Notes" : "Drive";
    sourceSpan.style.cssText = "color:#6b7280;min-width:80px;";

    const statusSpan = document.createElement("span");
    if (meeting.alreadyProcessed) {
      statusSpan.textContent = "Already processed";
      statusSpan.style.cssText = "color:#9ca3af;font-size:11px;min-width:100px;";
    } else {
      statusSpan.textContent = "New";
      statusSpan.style.cssText = "color:#166534;font-size:11px;font-weight:600;min-width:100px;";
    }

    row.append(cb, titleSpan, dateSpan, sourceSpan, statusSpan);
    scanResultsListEl.appendChild(row);
  }

  updateSelectionState();
}

scanSelectAllEl.addEventListener("change", () => {
  const newMeetings = scanResults.filter(m => !m.alreadyProcessed);
  if (scanSelectAllEl.checked) {
    for (const m of newMeetings) selectedIds.add(m.id);
  } else {
    for (const m of newMeetings) selectedIds.delete(m.id);
  }
  renderScanResults();
});

scanHistoryBtn.addEventListener("click", async () => {
  const fromDate = scanFromEl.value;
  const toDate   = scanToEl.value;

  clearDateError();

  if (!fromDate || !toDate) {
    showDateError("Please select both dates.");
    return;
  }
  if (fromDate > toDate) {
    showDateError("From date must be before or equal to To date.");
    return;
  }

  scanHistoryBtn.disabled = true;
  scanHistoryBtn.textContent = "Scanning…";
  scanFromEl.disabled = true;
  scanToEl.disabled = true;
  scanStatusEl.hidden = false;
  scanStatusEl.style.color = "";
  scanStatusEl.innerHTML = '<span class="loading-spinner"></span> Scanning your Drive…';
  scanResultsEl.hidden = true;
  scanResults = [];
  selectedIds.clear();
  processStatusEl.hidden = true;
  batchWarningEl.hidden = true;

  try {
    const result = await api.scanHistoryPreview(fromDate, toDate);
    scanResults = result.meetings ?? [];
    scanStatusEl.hidden = true;
    scanResultsEl.hidden = false;
    renderScanResults();
  } catch (err) {
    scanStatusEl.innerHTML = "";
    scanStatusEl.textContent = err.message || "Could not scan meetings. Please try again.";
    scanStatusEl.style.color = "#991b1b";
  } finally {
    scanHistoryBtn.disabled = false;
    scanHistoryBtn.textContent = "Scan Drive for Past Transcripts";
    scanFromEl.disabled = false;
    scanToEl.disabled = false;
  }
});

async function processSelection(meetings) {
  processSelectedBtn.disabled = true;
  processAllBtn.disabled = true;
  setRowCheckboxesDisabled(true);
  processStatusEl.hidden = false;
  processStatusEl.style.color = "";
  processStatusEl.innerHTML = '<span class="loading-spinner"></span> Queuing meetings…';

  try {
    const result = await api.processHistorySelection(meetings);
    const created = result.created ?? 0;
    processStatusEl.textContent = created > 0
      ? `${created} meeting${created !== 1 ? "s" : ""} queued for processing. Check your dashboard in a few minutes.`
      : "No new meetings were queued (all already processed).";
    processStatusEl.style.color = created > 0 ? "#166534" : "#6b7280";

    // Mark processed meetings as already-processed in local state
    if (created > 0) {
      for (const m of meetings) {
        const existing = scanResults.find(r => r.id === m.id);
        if (existing) existing.alreadyProcessed = true;
        selectedIds.delete(m.id);
      }
      renderScanResults();
    }
  } catch (err) {
    processStatusEl.textContent = err.message || "Could not queue selected meetings. Please try again.";
    processStatusEl.style.color = "#991b1b";
  } finally {
    setRowCheckboxesDisabled(false);
    updateSelectionState();
  }
}

processSelectedBtn.addEventListener("click", () => {
  const meetings = scanResults
    .filter(m => !m.alreadyProcessed && selectedIds.has(m.id))
    .map(({ id, title, date, source, driveFileLink }) => ({ id, title, date, source, driveFileLink }));
  if (meetings.length === 0) return;
  processSelection(meetings);
});

processAllBtn.addEventListener("click", () => {
  const meetings = scanResults
    .filter(m => !m.alreadyProcessed)
    .map(({ id, title, date, source, driveFileLink }) => ({ id, title, date, source, driveFileLink }));
  if (meetings.length === 0) return;
  if (!window.confirm(`Process all ${meetings.length} meeting${meetings.length !== 1 ? "s" : ""}? This will queue them for AI processing.`)) return;
  processSelection(meetings);
});
