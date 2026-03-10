import { requireAuth, requireAdminRole, signOutUser, showToast } from "./auth.js";
import { api } from "./api.js";

const loadingEl  = document.getElementById("loading");
const contentEl  = document.getElementById("content");
const chipEl     = document.getElementById("user-chip");
const logoutBtn  = document.getElementById("logout-btn");
const usersListEl = document.getElementById("users-list");

// Credentials elements
const credAiProvider        = document.getElementById("cred-ai-provider");
const credAiKey             = document.getElementById("cred-ai-key");
const maskedAiKey           = document.getElementById("masked-ai-key");
const saveAiBtn             = document.getElementById("save-ai-btn");

const credSlackToken        = document.getElementById("cred-slack-token");
const credSlackSecret       = document.getElementById("cred-slack-secret");
const credSlackClientId     = document.getElementById("cred-slack-client-id");
const credSlackClientSecret = document.getElementById("cred-slack-client-secret");
const maskedSlackToken      = document.getElementById("masked-slack-token");
const maskedSlackSecret     = document.getElementById("masked-slack-secret");
const maskedSlackClientId   = document.getElementById("masked-slack-client-id");
const maskedSlackClientSecret = document.getElementById("masked-slack-client-secret");
const saveSlackBtn          = document.getElementById("save-slack-btn");

const credAsanaId           = document.getElementById("cred-asana-id");
const credAsanaSecret       = document.getElementById("cred-asana-secret");
const maskedAsanaId         = document.getElementById("masked-asana-id");
const maskedAsanaSecret     = document.getElementById("masked-asana-secret");
const saveAsanaCredBtn      = document.getElementById("save-asana-cred-btn");

const testAiBtn             = document.getElementById("test-ai-btn");
const testAiResult          = document.getElementById("test-ai-result");
const testSlackBtn          = document.getElementById("test-slack-btn");
const testSlackResult       = document.getElementById("test-slack-result");
const testAsanaBtn          = document.getElementById("test-asana-btn");
const testAsanaResult       = document.getElementById("test-asana-result");
const testCredsBtn          = document.getElementById("test-creds-btn");
const testResultsEl         = document.getElementById("test-results");
const credsLastSaved        = document.getElementById("creds-last-saved");

const saveOrgDefaultsBtn    = document.getElementById("save-org-defaults-btn");
const orgExpiryHours        = document.getElementById("org-expiry-hours");
const orgAutoApprove        = document.getElementById("org-auto-approve");

// ─── Boot ──────────────────────────────────────────────────────────────────────

const user = await requireAuth();
if (!user) throw new Error("not reached");

chipEl.textContent = user.displayName || user.email;
logoutBtn.addEventListener("click", () => signOutUser());

const isAdmin = await requireAdminRole();
if (!isAdmin) throw new Error("not reached");

await loadUsers();
await loadCredentials();
await loadOrgDefaults();

loadingEl.hidden = true;
contentEl.hidden = false;

// ─── Tab switching ─────────────────────────────────────────────────────────────

for (const tab of document.querySelectorAll(".admin-tab")) {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab;
    for (const t of document.querySelectorAll(".admin-tab")) t.classList.remove("active");
    tab.classList.add("active");
    for (const pane of document.querySelectorAll(".tab-pane")) pane.hidden = true;
    document.getElementById(`tab-${target}`).hidden = false;
  });
}

// ─── Password reveal toggles ───────────────────────────────────────────────────

for (const btn of document.querySelectorAll(".reveal-btn")) {
  btn.addEventListener("click", () => {
    const input = document.getElementById(btn.dataset.target);
    if (input.type === "password") {
      input.type = "text";
      btn.textContent = "Hide";
    } else {
      input.type = "password";
      btn.textContent = "Show";
    }
  });
}

// ─── Credential save handlers ──────────────────────────────────────────────────

saveAiBtn.addEventListener("click", async () => {
  const provider = credAiProvider.value;
  const key = credAiKey.value.trim();
  if (!key) { showToast("Enter an API key.", "error"); return; }
  saveAiBtn.disabled = true;
  saveAiBtn.textContent = "Saving…";
  try {
    await api.setAdminSecrets({ ai: { provider, apiKey: key } });
    credAiKey.value = "";
    showToast("AI credentials saved.", "success");
    await loadCredentials();
  } catch (err) {
    showToast("Failed to save: " + err.message, "error");
  } finally {
    saveAiBtn.disabled = false;
    saveAiBtn.textContent = "Save AI";
  }
});

saveSlackBtn.addEventListener("click", async () => {
  const botToken     = credSlackToken.value.trim();
  const signingSecret = credSlackSecret.value.trim();
  const clientId     = credSlackClientId.value.trim();
  const clientSecret = credSlackClientSecret.value.trim();

  if (!botToken && !signingSecret && !clientId && !clientSecret) {
    showToast("Enter at least one Slack credential.", "error");
    return;
  }
  saveSlackBtn.disabled = true;
  saveSlackBtn.textContent = "Saving…";
  try {
    const payload = {};
    if (botToken) payload.botToken = botToken;
    if (signingSecret) payload.signingSecret = signingSecret;
    if (clientId) payload.clientId = clientId;
    if (clientSecret) payload.clientSecret = clientSecret;
    await api.setAdminSecrets({ slack: payload });
    credSlackToken.value = "";
    credSlackSecret.value = "";
    credSlackClientId.value = "";
    credSlackClientSecret.value = "";
    showToast("Slack credentials saved.", "success");
    await loadCredentials();
  } catch (err) {
    showToast("Failed to save: " + err.message, "error");
  } finally {
    saveSlackBtn.disabled = false;
    saveSlackBtn.textContent = "Save Slack";
  }
});

saveAsanaCredBtn.addEventListener("click", async () => {
  const clientId     = credAsanaId.value.trim();
  const clientSecret = credAsanaSecret.value.trim();
  if (!clientId && !clientSecret) { showToast("Enter at least one Asana credential.", "error"); return; }
  saveAsanaCredBtn.disabled = true;
  saveAsanaCredBtn.textContent = "Saving…";
  try {
    const payload = {};
    if (clientId) payload.clientId = clientId;
    if (clientSecret) payload.clientSecret = clientSecret;
    await api.setAdminSecrets({ asana: payload });
    credAsanaId.value = "";
    credAsanaSecret.value = "";
    showToast("Asana credentials saved.", "success");
    await loadCredentials();
  } catch (err) {
    showToast("Failed to save: " + err.message, "error");
  } finally {
    saveAsanaCredBtn.disabled = false;
    saveAsanaCredBtn.textContent = "Save Asana";
  }
});

// ─── Per-section test handlers ─────────────────────────────────────────────────

async function runTest(keys, resultEl, btn) {
  btn.disabled = true;
  btn.textContent = "Testing…";
  resultEl.hidden = true;
  try {
    const results = await api.testAdminSecrets();
    const rows = keys.map((key) => {
      const val = results[key];
      if (!val) return "";
      const icon  = val.status === "ok" ? "✓" : val.status === "not_configured" ? "—" : "✗";
      const color = val.status === "ok" ? "#16a34a" : val.status === "not_configured" ? "#6b7280" : "#dc2626";
      const detail = val.message || val.team || "";
      return `<div style="color:${color}"><strong>${icon} ${escHtml(key)}</strong>${detail ? ` — ${escHtml(detail)}` : ""}</div>`;
    });
    resultEl.innerHTML = rows.join("");
    resultEl.hidden = false;
  } catch (err) {
    showToast("Test failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Test Connection";
  }
}

testAiBtn.addEventListener("click", () => runTest(["ai"], testAiResult, testAiBtn));
testSlackBtn.addEventListener("click", () => runTest(["slack"], testSlackResult, testSlackBtn));
testAsanaBtn.addEventListener("click", () => runTest(["asana"], testAsanaResult, testAsanaBtn));

testCredsBtn.addEventListener("click", async () => {
  testCredsBtn.disabled = true;
  testCredsBtn.textContent = "Testing…";
  testResultsEl.hidden = true;
  try {
    const results = await api.testAdminSecrets();
    const rows = [];
    for (const [key, val] of Object.entries(results)) {
      const icon  = val.status === "ok" ? "✓" : val.status === "not_configured" ? "—" : "✗";
      const color = val.status === "ok" ? "#16a34a" : val.status === "not_configured" ? "#6b7280" : "#dc2626";
      const detail = val.message || val.team || "";
      rows.push(`<div style="color:${color}"><strong>${icon} ${escHtml(key)}</strong>${detail ? ` — ${escHtml(detail)}` : ""}</div>`);
    }
    testResultsEl.innerHTML = rows.join("");
    testResultsEl.hidden = false;
  } catch (err) {
    showToast("Test failed: " + err.message, "error");
  } finally {
    testCredsBtn.disabled = false;
    testCredsBtn.textContent = "Test All";
  }
});

// ─── Load credentials ──────────────────────────────────────────────────────────

async function loadCredentials() {
  try {
    const data = await api.getAdminSecrets();

    // AI
    maskedAiKey.textContent = data.ai?.apiKey
      ? `Key configured (${escHtml(data.ai.provider ?? "")})`
      : "Not configured";
    if (data.ai?.provider) credAiProvider.value = data.ai.provider;

    // Slack
    maskedSlackToken.textContent        = data.slack?.botToken      ? "Configured (••••••••)" : "Not configured";
    maskedSlackSecret.textContent       = data.slack?.signingSecret ? "Configured (••••••••)" : "Not configured";
    maskedSlackClientId.textContent     = data.slack?.clientId      ? escHtml(data.slack.clientId) : "Not configured";
    maskedSlackClientSecret.textContent = data.slack?.clientSecret  ? "Configured (••••••••)" : "Not configured";

    // Asana
    maskedAsanaId.textContent     = data.asana?.clientId     ? escHtml(data.asana.clientId) : "Not configured";
    maskedAsanaSecret.textContent = data.asana?.clientSecret ? "Configured (••••••••)" : "Not configured";

    // Last saved
    if (data.configuredAt) {
      const date = data.configuredAt.toDate
        ? data.configuredAt.toDate()
        : new Date(data.configuredAt._seconds * 1000);
      credsLastSaved.textContent = `Last saved ${date.toLocaleString()}`;
    } else {
      credsLastSaved.textContent = "";
    }
  } catch (err) {
    showToast("Failed to load credentials: " + err.message, "error");
  }
}

// ─── Load users ────────────────────────────────────────────────────────────────

async function loadUsers() {
  try {
    const { users } = await api.listUsers();
    renderUsers(users);
  } catch (err) {
    showToast("Failed to load users: " + err.message, "error");
  }
}

function renderUsers(users) {
  usersListEl.innerHTML = "";

  if (!users.length) {
    usersListEl.innerHTML = "<p class=\"empty-hint\">No users found.</p>";
    return;
  }

  const table = document.createElement("table");
  table.className = "admin-table";
  table.innerHTML = `
    <colgroup>
      <col class="col-user">
      <col class="col-role">
      <col class="col-active">
      <col class="col-actions">
    </colgroup>
    <thead>
      <tr>
        <th>User</th>
        <th>Role</th>
        <th>Active</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  for (const u of users) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>
        <strong>${escHtml(u.displayName || u.email)}</strong><br>
        <small style="color:#6b7280">${escHtml(u.email)}</small>
      </td>
      <td>
        <select data-uid="${escHtml(u.uid)}" class="role-select" ${u.uid === user.uid ? "disabled" : ""}>
          <option value="user" ${u.role === "user" ? "selected" : ""}>User</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
      </td>
      <td>
        <label class="toggle-label">
          <input type="checkbox" data-uid="${escHtml(u.uid)}" class="status-toggle"
            ${u.isActive ? "checked" : ""}
            ${u.uid === user.uid ? "disabled" : ""}>
          <span class="toggle-track"></span>
        </label>
      </td>
      <td>
        <button class="btn btn-ghost delete-btn" data-uid="${escHtml(u.uid)}"
          ${u.uid === user.uid ? "disabled" : ""}
          style="color:#dc2626;font-size:13px;">Delete</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  usersListEl.appendChild(table);

  for (const sel of table.querySelectorAll(".role-select")) {
    sel.addEventListener("change", async (e) => {
      const uid = sel.dataset.uid;
      const role = e.target.value;
      try {
        await api.setUserRole(uid, role);
        showToast(`Role updated to "${role}"`);
      } catch (err) {
        showToast("Failed to update role: " + err.message, "error");
        await loadUsers();
      }
    });
  }

  for (const cb of table.querySelectorAll(".status-toggle")) {
    cb.addEventListener("change", async () => {
      const uid = cb.dataset.uid;
      try {
        await api.setUserStatus(uid, cb.checked);
        showToast(`User ${cb.checked ? "activated" : "deactivated"}`);
      } catch (err) {
        showToast("Failed to update status: " + err.message, "error");
        await loadUsers();
      }
    });
  }

  for (const btn of table.querySelectorAll(".delete-btn")) {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.uid;
      if (!confirm("Permanently delete this user? This cannot be undone.")) return;
      try {
        await api.deleteUser(uid);
        showToast("User deleted");
        await loadUsers();
      } catch (err) {
        showToast("Failed to delete user: " + err.message, "error");
      }
    });
  }
}

// ─── Org defaults ──────────────────────────────────────────────────────────────

async function loadOrgDefaults() {
  try {
    const data = await api.getOrgDefaults();
    for (const cb of document.querySelectorAll("input[name=\"org-notify-via\"]")) {
      cb.checked = data.notifyVia.includes(cb.value);
    }
    for (const cb of document.querySelectorAll("input[name=\"org-task-dest\"]")) {
      cb.checked = data.taskDestination.includes(cb.value);
    }
    const match = orgExpiryHours.querySelector(`option[value="${data.proposalExpiryHours}"]`);
    if (match) match.selected = true;
    orgAutoApprove.checked = data.autoApprove === true;
  } catch (err) {
    showToast("Could not load org defaults: " + err.message, "error");
  }
}

saveOrgDefaultsBtn.addEventListener("click", async () => {
  const notifyVia = [...document.querySelectorAll("input[name=\"org-notify-via\"]:checked")]
    .map((cb) => cb.value);
  const taskDestination = [...document.querySelectorAll("input[name=\"org-task-dest\"]:checked")]
    .map((cb) => cb.value);

  if (!notifyVia.length) { showToast("Select at least one notification channel.", "error"); return; }
  if (!taskDestination.length) { showToast("Select at least one task destination.", "error"); return; }

  saveOrgDefaultsBtn.disabled = true;
  saveOrgDefaultsBtn.textContent = "Saving…";
  try {
    await api.updateOrgDefaults({
      notifyVia,
      taskDestination,
      proposalExpiryHours: parseInt(orgExpiryHours.value, 10),
      autoApprove: orgAutoApprove.checked,
    });
    showToast("Org defaults saved.", "success");
  } catch (err) {
    showToast("Failed to save org defaults: " + err.message, "error");
  } finally {
    saveOrgDefaultsBtn.disabled = false;
    saveOrgDefaultsBtn.textContent = "Save Org Defaults";
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
