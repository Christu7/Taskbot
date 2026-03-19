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


