import { requireAuth, signOutUser, showToast } from "./auth.js";
import { api } from "./api.js";

const loadingEl     = document.getElementById("loading");
const contentEl     = document.getElementById("content");
const chipEl        = document.getElementById("user-chip");
const logoutBtn     = document.getElementById("logout-btn");
const reconnectBtn  = document.getElementById("reconnect-btn");
const accountEmail  = document.getElementById("account-email");
const tokenStatus   = document.getElementById("token-status");
const isActiveEl    = document.getElementById("is-active");
const autoApproveEl = document.getElementById("auto-approve");
const expiryEl      = document.getElementById("expiry-hours");
const saveBtn       = document.getElementById("save-btn");

// ─── Boot ─────────────────────────────────────────────────────────────────────

const user = await requireAuth();
if (!user) throw new Error("not reached");

chipEl.textContent = user.displayName || user.email;
logoutBtn.addEventListener("click", () => signOutUser());

reconnectBtn.addEventListener("click", async () => {
  const token = await user.getIdToken();
  const base = location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? "http://127.0.0.1:5001/taskbot-fb10d/us-central1"
    : "https://us-central1-taskbot-fb10d.cloudfunctions.net";
  window.location.href = `${base}/oauthInit?token=${token}`;
});

saveBtn.addEventListener("click", saveSettings);

await loadSettings();

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

    loadingEl.hidden = false;
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
    await api.updateSettings({
      isActive: isActiveEl.checked,
      preferences: {
        autoApprove: autoApproveEl.checked,
        proposalExpiryHours: parseInt(expiryEl.value, 10),
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
