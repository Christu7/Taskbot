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
await loadUserStats();
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

// ─── User stats ────────────────────────────────────────────────────────────────

async function loadUserStats() {
  try {
    const stats = await api.getUserStats();
    document.getElementById("stat-total").textContent  = stats.total;
    document.getElementById("stat-active").textContent = stats.active;
    document.getElementById("stat-admins").textContent = stats.admins;
    document.getElementById("stat-asana").textContent  = stats.connectedAsana;
    document.getElementById("stat-slack").textContent  = stats.connectedSlack;
  } catch (err) {
    // non-fatal — stats bar just stays at "—"
  }
}

// ─── Load & filter users ──────────────────────────────────────────────────────

let allUsers = [];

async function loadUsers() {
  try {
    const { users } = await api.listUsers();
    allUsers = users;
    applyFilters();
  } catch (err) {
    showToast("Failed to load users: " + err.message, "error");
  }
}

function applyFilters() {
  const search = document.getElementById("user-search").value.trim().toLowerCase();
  const role   = document.getElementById("filter-role").value;
  const status = document.getElementById("filter-status").value;

  let filtered = allUsers;
  if (search) {
    filtered = filtered.filter(u =>
      (u.displayName || "").toLowerCase().includes(search) ||
      (u.email || "").toLowerCase().includes(search)
    );
  }
  if (role) filtered = filtered.filter(u => u.role === role);
  if (status === "active")   filtered = filtered.filter(u => u.isActive);
  if (status === "inactive") filtered = filtered.filter(u => !u.isActive);

  renderUsers(filtered);
}

document.getElementById("user-search").addEventListener("input", applyFilters);
document.getElementById("filter-role").addEventListener("change", applyFilters);
document.getElementById("filter-status").addEventListener("change", applyFilters);

// ─── Bulk selection ───────────────────────────────────────────────────────────

let selectedUids = new Set();

function updateBulkBar() {
  const bar = document.getElementById("bulk-bar");
  const count = document.getElementById("bulk-count");
  bar.hidden = selectedUids.size === 0;
  count.textContent = `${selectedUids.size} selected`;
}

document.getElementById("bulk-clear-btn").addEventListener("click", () => {
  selectedUids.clear();
  for (const cb of document.querySelectorAll(".user-checkbox")) cb.checked = false;
  const selectAll = document.getElementById("select-all-cb");
  if (selectAll) selectAll.checked = false;
  updateBulkBar();
});

document.getElementById("bulk-activate-btn").addEventListener("click", () =>
  bulkStatus(true));
document.getElementById("bulk-deactivate-btn").addEventListener("click", () =>
  bulkStatus(false));

async function bulkStatus(isActive) {
  const uids = [...selectedUids].filter(uid => uid !== user.uid);
  if (!uids.length) { showToast("No eligible users selected.", "error"); return; }
  try {
    await api.bulkSetUserStatus(uids, isActive);
    showToast(`${uids.length} user(s) ${isActive ? "activated" : "deactivated"}.`);
    selectedUids.clear();
    updateBulkBar();
    await loadUsers();
    await loadUserStats();
  } catch (err) {
    showToast("Bulk update failed: " + err.message, "error");
  }
}

// ─── Invite modal ─────────────────────────────────────────────────────────────

document.getElementById("invite-btn").addEventListener("click", () => {
  document.getElementById("invite-email").value = "";
  document.getElementById("invite-modal").hidden = false;
});
document.getElementById("invite-cancel-btn").addEventListener("click", () => {
  document.getElementById("invite-modal").hidden = true;
});
document.getElementById("invite-send-btn").addEventListener("click", async () => {
  const email = document.getElementById("invite-email").value.trim();
  if (!email) { showToast("Enter an email address.", "error"); return; }
  const btn = document.getElementById("invite-send-btn");
  btn.disabled = true;
  btn.textContent = "Sending…";
  try {
    await api.inviteUser(email);
    document.getElementById("invite-modal").hidden = true;
    showToast(`Invite sent to ${email}.`, "success");
  } catch (err) {
    showToast("Failed to send invite: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Send Invite";
  }
});

// ─── Render users table ───────────────────────────────────────────────────────

function renderUsers(users) {
  usersListEl.innerHTML = "";

  if (!users.length) {
    usersListEl.innerHTML = "<p class='empty-hint' style='padding:20px;'>No users match the current filter.</p>";
    return;
  }

  const table = document.createElement("table");
  table.className = "admin-table";
  table.style.fontSize = "13px";
  table.innerHTML = `
    <thead>
      <tr>
        <th style="width:32px;"><input type="checkbox" id="select-all-cb" /></th>
        <th>User</th>
        <th>Role</th>
        <th>Status</th>
        <th>Connections</th>
        <th>Tasks</th>
        <th>Last Active</th>
        <th>Actions</th>
      </tr>
    </thead>
    <tbody></tbody>
  `;
  const tbody = table.querySelector("tbody");

  for (const u of users) {
    const tr = document.createElement("tr");
    const lastActive = u.lastActiveAt
      ? (u.lastActiveAt.toDate ? u.lastActiveAt.toDate() : new Date(u.lastActiveAt._seconds * 1000)).toLocaleDateString()
      : "—";

    const googleIcon = `<span class="conn-icon conn-ok" title="Google connected">G</span>`;
    const asanaIcon  = u.asanaConnected
      ? `<span class="conn-icon conn-ok" title="Asana connected">A</span>`
      : `<span class="conn-icon conn-no" title="Asana not connected">A</span>`;
    const slackIcon  = u.slackConnected
      ? `<span class="conn-icon conn-ok" title="Slack connected">S</span>`
      : `<span class="conn-icon conn-no" title="Slack not connected">S</span>`;

    tr.innerHTML = `
      <td><input type="checkbox" class="user-checkbox" data-uid="${escHtml(u.uid)}" ${u.uid === user.uid ? "disabled" : ""} /></td>
      <td>
        <strong>${escHtml(u.displayName || u.email)}</strong><br>
        <span style="color:#6b7280">${escHtml(u.email)}</span>
      </td>
      <td><span class="badge badge-${u.role}">${escHtml(u.role)}</span></td>
      <td><span class="badge badge-${u.isActive ? "active" : "inactive"}">${u.isActive ? "Active" : "Inactive"}</span></td>
      <td style="letter-spacing:4px;">${googleIcon}${asanaIcon}${slackIcon}</td>
      <td>${u.taskCount ?? 0}</td>
      <td>${lastActive}</td>
      <td style="white-space:nowrap;">
        <label class="toggle-label" title="${u.isActive ? "Deactivate" : "Activate"}">
          <input type="checkbox" class="status-toggle" data-uid="${escHtml(u.uid)}"
            ${u.isActive ? "checked" : ""}
            ${u.uid === user.uid ? "disabled" : ""}>
          <span class="toggle-track"></span>
        </label>
        <select data-uid="${escHtml(u.uid)}" class="role-select"
          style="font-size:12px;padding:3px 6px;margin-left:6px;"
          ${u.uid === user.uid ? "disabled" : ""}>
          <option value="user"  ${u.role === "user"  ? "selected" : ""}>User</option>
          <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
        </select>
        <button class="btn btn-ghost delete-btn" data-uid="${escHtml(u.uid)}" data-name="${escHtml(u.displayName || u.email)}"
          ${u.uid === user.uid ? "disabled" : ""}
          style="color:#dc2626;font-size:12px;padding:3px 8px;margin-left:4px;">Remove</button>
      </td>
    `;
    tbody.appendChild(tr);
  }

  usersListEl.appendChild(table);

  // Select-all checkbox
  const selectAllCb = table.querySelector("#select-all-cb");
  selectAllCb.addEventListener("change", () => {
    for (const cb of table.querySelectorAll(".user-checkbox:not(:disabled)")) {
      cb.checked = selectAllCb.checked;
      if (selectAllCb.checked) selectedUids.add(cb.dataset.uid);
      else selectedUids.delete(cb.dataset.uid);
    }
    updateBulkBar();
  });

  // Per-row checkboxes
  for (const cb of table.querySelectorAll(".user-checkbox")) {
    cb.checked = selectedUids.has(cb.dataset.uid);
    cb.addEventListener("change", () => {
      if (cb.checked) selectedUids.add(cb.dataset.uid);
      else selectedUids.delete(cb.dataset.uid);
      const allChecked = [...table.querySelectorAll(".user-checkbox:not(:disabled)")].every(c => c.checked);
      selectAllCb.checked = allChecked;
      updateBulkBar();
    });
  }

  // Role change
  for (const sel of table.querySelectorAll(".role-select")) {
    sel.addEventListener("change", async (e) => {
      const uid = sel.dataset.uid;
      const role = e.target.value;
      const targetUser = allUsers.find(u => u.uid === uid);
      const name = targetUser?.displayName || targetUser?.email || uid;

      const verb = role === "admin" ? "promote" : "demote";
      if (!confirm(`${verb.charAt(0).toUpperCase() + verb.slice(1)} ${name} to ${role}?`)) {
        sel.value = role === "admin" ? "user" : "admin";
        return;
      }
      try {
        await api.setUserRole(uid, role);
        showToast(`Role updated to "${role}"`);
        await loadUsers();
        await loadUserStats();
      } catch (err) {
        showToast("Failed to update role: " + err.message, "error");
        await loadUsers();
      }
    });
  }

  // Status toggle
  for (const cb of table.querySelectorAll(".status-toggle")) {
    cb.addEventListener("change", async () => {
      const uid = cb.dataset.uid;
      try {
        await api.setUserStatus(uid, cb.checked);
        showToast(`User ${cb.checked ? "activated" : "deactivated"}`);
        await loadUsers();
        await loadUserStats();
      } catch (err) {
        showToast("Failed to update status: " + err.message, "error");
        await loadUsers();
      }
    });
  }

  // Delete / remove
  for (const btn of table.querySelectorAll(".delete-btn")) {
    btn.addEventListener("click", async () => {
      const uid = btn.dataset.uid;
      const name = btn.dataset.name;
      if (!confirm(`Remove ${name}? This will deactivate their account and remove their stored tokens. Their existing tasks will not be deleted.`)) return;
      try {
        await api.deleteUser(uid);
        showToast("User removed");
        selectedUids.delete(uid);
        updateBulkBar();
        await loadUsers();
        await loadUserStats();
      } catch (err) {
        showToast("Failed to remove user: " + err.message, "error");
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
