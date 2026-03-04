import { requireAuth, signOutUser, showToast } from "./auth.js";
import { api } from "./api.js";

const loadingEl        = document.getElementById("loading");
const contentEl        = document.getElementById("content");
const chipEl           = document.getElementById("user-chip");
const logoutBtn        = document.getElementById("logout-btn");
const reconnectBtn     = document.getElementById("reconnect-btn");
const accountEmail     = document.getElementById("account-email");
const tokenStatus      = document.getElementById("token-status");
const isActiveEl       = document.getElementById("is-active");
const autoApproveEl    = document.getElementById("auto-approve");
const expiryEl         = document.getElementById("expiry-hours");
const saveBtn          = document.getElementById("save-btn");
const activeProviderEl = document.getElementById("active-provider");
const saveProviderBtn  = document.getElementById("save-provider-btn");

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
saveProviderBtn.addEventListener("click", saveActiveProvider);

// ─── AI Provider key controls ─────────────────────────────────────────────────

for (const provider of ["anthropic", "openai"]) {
  document.getElementById(`add-${provider}`).addEventListener("click", () => {
    document.getElementById(`input-${provider}`).hidden = false;
    document.getElementById(`key-input-${provider}`).focus();
  });

  document.getElementById(`cancel-${provider}`).addEventListener("click", () => {
    document.getElementById(`input-${provider}`).hidden = true;
    document.getElementById(`key-input-${provider}`).value = "";
  });

  document.getElementById(`confirm-${provider}`).addEventListener("click", async () => {
    const input = document.getElementById(`key-input-${provider}`);
    const key = input.value.trim();
    if (!key) { showToast("Enter a key first.", "error"); return; }

    const btn = document.getElementById(`confirm-${provider}`);
    btn.disabled = true;
    btn.textContent = "Saving…";
    try {
      await api.addApiKey(provider, key);
      input.value = "";
      document.getElementById(`input-${provider}`).hidden = true;
      showToast(`${provider} key saved.`, "success");
      await loadApiKeys();
    } catch (err) {
      showToast("Failed to save key: " + err.message, "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "Confirm";
    }
  });
}

await loadSettings();
await loadApiKeys();

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

// ─── Load API keys ─────────────────────────────────────────────────────────────

async function loadApiKeys() {
  try {
    const data = await api.getApiKeys();

    for (const provider of ["anthropic", "openai"]) {
      const info = data.providers[provider];
      const maskedEl   = document.getElementById(`masked-${provider}`);
      const actionsEl  = document.getElementById(`actions-${provider}`);

      if (info.configured) {
        maskedEl.textContent = info.masked ?? "Configured";

        // Replace Add button with Remove button (clear and rebuild to avoid duplicate listeners)
        actionsEl.innerHTML = "";
        const removeBtn = document.createElement("button");
        removeBtn.className = "btn btn-ghost";
        removeBtn.textContent = "Remove";
        removeBtn.addEventListener("click", async () => {
          removeBtn.disabled = true;
          removeBtn.textContent = "Removing…";
          try {
            await api.removeApiKey(provider);
            showToast(`${provider} key removed.`, "success");
            await loadApiKeys();
          } catch (err) {
            showToast("Failed to remove key: " + err.message, "error");
            removeBtn.disabled = false;
            removeBtn.textContent = "Remove";
          }
        });
        actionsEl.appendChild(removeBtn);
      } else {
        maskedEl.textContent = "Not configured";
        actionsEl.innerHTML = "";
        const addBtn = document.createElement("button");
        addBtn.className = "btn btn-ghost";
        addBtn.id = `add-${provider}`;
        addBtn.textContent = "Add Key";
        addBtn.addEventListener("click", () => {
          document.getElementById(`input-${provider}`).hidden = false;
          document.getElementById(`key-input-${provider}`).focus();
        });
        actionsEl.appendChild(addBtn);
      }
    }

    // Sync active provider selector — only enable options for configured providers
    const currentActive = data.activeProvider ?? "";
    activeProviderEl.value = currentActive;

    for (const opt of activeProviderEl.options) {
      if (opt.value === "") continue; // always allow env-default option
      opt.disabled = !data.providers[opt.value]?.configured;
    }

  } catch (err) {
    showToast("Failed to load API keys: " + err.message, "error");
  }
}

// ─── Save active provider ──────────────────────────────────────────────────────

async function saveActiveProvider() {
  const provider = activeProviderEl.value;
  if (!provider) {
    showToast("Select a provider to activate.", "error");
    return;
  }

  saveProviderBtn.disabled = true;
  saveProviderBtn.textContent = "Saving…";
  try {
    await api.setActiveProvider(provider);
    showToast(`Active provider set to ${provider}.`, "success");
  } catch (err) {
    showToast("Failed to set provider: " + err.message, "error");
  } finally {
    saveProviderBtn.disabled = false;
    saveProviderBtn.textContent = "Save Provider";
  }
}
