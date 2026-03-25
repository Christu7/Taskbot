import { requireAuth, requireAdminRole, requireProjectManagerRole, getUserRole, signOutUser, showToast } from "./auth.js";
import { api } from "./api.js";

const loadingEl    = document.getElementById("loading");
const contentEl    = document.getElementById("content");
const wizardEl     = document.getElementById("setup-wizard");
const chipEl       = document.getElementById("user-chip");
const logoutBtn    = document.getElementById("logout-btn");
const usersListEl  = document.getElementById("users-list");

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

// ─── State ─────────────────────────────────────────────────────────────────────
// Declare module-level state before any top-level awaits to avoid TDZ errors.

let allUsers = [];
let selectedUids = new Set();
let meetingsCursor = null;

// ─── Boot ──────────────────────────────────────────────────────────────────────

const user = await requireAuth();
if (!user) throw new Error("not reached");

chipEl.textContent = user.displayName || user.email;
logoutBtn.addEventListener("click", () => signOutUser());

// Allow both admin and project_manager to access the panel
const canAccess = await requireProjectManagerRole();
if (!canAccess) throw new Error("not reached");

const currentRole = await getUserRole();
const isCurrentUserAdmin = currentRole === "admin";

// Hide admin-only tabs for project managers
if (!isCurrentUserAdmin) {
  for (const tab of document.querySelectorAll(".admin-tab[data-tab='settings'], .admin-tab[data-tab='users']")) {
    tab.hidden = true;
  }
  // Default to dashboard tab for PMs
  const dashTab = document.querySelector(".admin-tab[data-tab='dashboard']");
  if (dashTab) {
    for (const t of document.querySelectorAll(".admin-tab")) t.classList.remove("active");
    dashTab.classList.add("active");
  }
}

// Check if setup wizard should be shown (first admin, no credentials yet)
let showWizard = false;
if (isCurrentUserAdmin) {
  try {
    const status = await api.getSetupStatus();
    showWizard = !status.completed;
  } catch {
    // Setup status check failed — proceed to normal panel
  }
}

if (showWizard) {
  loadingEl.hidden = true;
  wizardEl.hidden = false;
  initSetupWizard();
} else {
  if (isCurrentUserAdmin) {
    await loadUsers();
    await loadUserStats();
    await loadCredentials();
    await loadOrgDefaults();
  }

  loadingEl.hidden = true;
  contentEl.hidden = false;

  // PMs default to dashboard tab — load it immediately
  if (!isCurrentUserAdmin) {
    for (const pane of document.querySelectorAll(".tab-pane")) pane.hidden = true;
    const dashPane = document.getElementById("tab-dashboard");
    if (dashPane) dashPane.hidden = false;
    await loadDashboard();
    dashboardLoaded = true;
  }
}

// ─── Tab switching ─────────────────────────────────────────────────────────────

let dashboardLoaded = false;
let meetingsLoaded = false;

for (const tab of document.querySelectorAll(".admin-tab")) {
  tab.addEventListener("click", async () => {
    const target = tab.dataset.tab;

    // Block PM users from accessing admin-only tabs
    if (!isCurrentUserAdmin && (target === "settings" || target === "users")) return;

    for (const t of document.querySelectorAll(".admin-tab")) t.classList.remove("active");
    tab.classList.add("active");
    for (const pane of document.querySelectorAll(".tab-pane")) pane.hidden = true;
    document.getElementById(`tab-${target}`).hidden = false;

    if (target === "dashboard" && !dashboardLoaded) {
      dashboardLoaded = true;
      await loadDashboard();
    }
    if (target === "meetings" && !meetingsLoaded) {
      meetingsLoaded = true;
      await loadMeetings();
    }
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
      <td><span class="badge badge-${u.role}">${escHtml(u.role === "project_manager" ? "PM" : u.role)}</span></td>
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
          ${(u.uid === user.uid || !isCurrentUserAdmin) ? "disabled" : ""}>
          <option value="user"            ${u.role === "user"            ? "selected" : ""}>User</option>
          <option value="project_manager" ${u.role === "project_manager" ? "selected" : ""}>Project Manager</option>
          <option value="admin"           ${u.role === "admin"           ? "selected" : ""}>Admin</option>
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
      const prevRole = targetUser?.role ?? "user";

      const roleLabels = { admin: "Admin", project_manager: "Project Manager", user: "User" };
      if (!confirm(`Change ${name}'s role to ${roleLabels[role] ?? role}?`)) {
        sel.value = prevRole;
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

// ─── Dashboard ────────────────────────────────────────────────────────────────

async function loadDashboard() {
  try {
    const [dash, { entries }] = await Promise.all([
      api.getDashboard(),
      api.getActivity(20),
    ]);

    // Summary cards
    document.getElementById("dash-users").textContent = dash.users.total;
    document.getElementById("dash-users-sub").textContent =
      `${dash.users.active} active / ${dash.users.total} total`;

    document.getElementById("dash-meetings").textContent = dash.meetings.thisWeek;
    document.getElementById("dash-meetings-sub").textContent =
      `${dash.meetings.thisWeek} this week / ${dash.meetings.total} total`;

    document.getElementById("dash-tasks").textContent = dash.tasks.thisWeek;
    document.getElementById("dash-tasks-sub").textContent =
      `${dash.tasks.thisWeek} this week / ${dash.tasks.total} total`;

    document.getElementById("dash-cost").textContent =
      `$${dash.aiUsage.estimatedCostThisMonth.toFixed(2)}`;
    document.getElementById("dash-cost-sub").textContent =
      `$${dash.aiUsage.estimatedCostThisWeek.toFixed(2)} this week`;

    // Activity feed
    renderActivityFeed(entries);

    // System health
    renderHealthPanel(dash.integrations);
  } catch (err) {
    showToast("Failed to load dashboard: " + err.message, "error");
  }
}

const ACTIVITY_ICONS = {
  meeting_processed: "📋",
  tasks_created: "✅",
  notifications_sent: "📧",
  user_joined: "👤",
  sync_complete: "🔄",
  reprocess_triggered: "🔁",
  task_approved: "✓",
};

function renderActivityFeed(entries) {
  const el = document.getElementById("activity-feed");
  if (!entries.length) {
    el.innerHTML = "<span style='color:#9ca3af;'>No activity yet.</span>";
    return;
  }
  el.innerHTML = entries.map((e) => {
    const icon = ACTIVITY_ICONS[e.type] || "•";
    const ts = e.timestamp
      ? (e.timestamp.toDate ? e.timestamp.toDate() : new Date(e.timestamp._seconds * 1000))
          .toLocaleString()
      : "";
    return `<div style="display:flex;gap:10px;padding:8px 0;border-bottom:1px solid #f3f4f6;">
      <span style="font-size:16px;flex-shrink:0;">${icon}</span>
      <div>
        <div>${escHtml(e.message)}</div>
        <div style="color:#9ca3af;font-size:11px;">${ts}</div>
      </div>
    </div>`;
  }).join("");
}

function renderHealthPanel(integrations) {
  const el = document.getElementById("health-panel");
  if (!integrations) { el.innerHTML = "<span style='color:#9ca3af;'>Unavailable</span>"; return; }
  const rows = [
    ["AI Provider", integrations.ai],
    ["Slack", integrations.slack],
    ["Asana", integrations.asana],
  ].map(([label, val]) => {
    const ok = val?.status === "configured" || val?.status === "ok";
    const icon = ok ? "✓" : "✗";
    const color = ok ? "#16a34a" : "#dc2626";
    const detail = val?.status === "not_configured" ? "Not configured" : (val?.message ?? val?.status ?? "—");
    return `<div style="display:flex;justify-content:space-between;padding:4px 0;">
      <span>${escHtml(String(label))}</span>
      <span style="color:${color};font-weight:500;">${icon} ${escHtml(String(detail))}</span>
    </div>`;
  });
  el.innerHTML = rows.join('<hr style="border:none;border-top:1px solid #f3f4f6;margin:4px 0;">');
}

// ─── Meetings ─────────────────────────────────────────────────────────────────

async function loadMeetings(append = false) {
  if (!append) meetingsCursor = null;
  const status = document.getElementById("meetings-filter-status").value;
  try {
    const params = { limit: 30 };
    if (status) params.status = status;
    if (append && meetingsCursor) params.cursor = meetingsCursor;

    const { meetings, nextCursor } = await api.getMeetings(params);
    meetingsCursor = nextCursor;

    const loadMoreBtn = document.getElementById("meetings-load-more-btn");
    loadMoreBtn.hidden = !nextCursor;

    if (!append) {
      renderMeetings(meetings);
    } else {
      appendMeetings(meetings);
    }
  } catch (err) {
    showToast("Failed to load meetings: " + err.message, "error");
  }
}

document.getElementById("meetings-filter-status").addEventListener("change", () => loadMeetings());
document.getElementById("meetings-load-more-btn").addEventListener("click", () => loadMeetings(true));

const STATUS_COLORS = {
  pending: "#f59e0b",
  processing: "#3b82f6",
  extracting: "#8b5cf6",
  proposed: "#10b981",
  completed: "#6b7280",
  failed: "#ef4444",
  awaiting_configuration: "#f97316",
};

/** Map raw transcriptFormat + sourceType to a human-readable label. */
function formatLabel(m) {
  if (m.sourceType === "gmail_gemini_notes") return "Gemini Notes (Email)";
  if (m.transcriptFormat === "gemini_notes")  return "Gemini Notes (Drive)";
  if (m.transcriptFormat === "plain_transcript") return "Transcript";
  return m.transcriptFormat || "—";
}

function meetingRow(m) {
  const color = STATUS_COLORS[m.status] || "#6b7280";
  const date = m.detectedAt
    ? (m.detectedAt.toDate ? m.detectedAt.toDate() : new Date(m.detectedAt._seconds * 1000))
        .toLocaleDateString()
    : "—";
  const attendees = (m.attendeeEmails ?? []).length;
  const canReprocess = m.status === "failed" || m.status === "awaiting_configuration" || m.status === "processing";
  let stuckLabel = "";
  if (m.status === "processing" && m.processingStartedAt) {
    const startedMs = m.processingStartedAt._seconds
      ? m.processingStartedAt._seconds * 1000
      : new Date(m.processingStartedAt).getTime();
    const minutesAgo = Math.floor((Date.now() - startedMs) / 60000);
    if (minutesAgo >= 5) {
      stuckLabel = ` (stuck ${minutesAgo}m)`;
    }
  }
  const tokens = m.tokensUsed
    ? `${(m.tokensUsed.input + m.tokensUsed.output).toLocaleString()} tokens`
    : "—";

  return `<tr class="meeting-row" data-meeting-id="${escHtml(m.id)}">
    <td>
      <a href="${escHtml(m.driveFileLink || "#")}" target="_blank" style="color:#2563eb;text-decoration:none;font-weight:500;">
        ${escHtml(m.meetingTitle)}
      </a>
      ${m.error ? `<div style="color:#ef4444;font-size:11px;margin-top:2px;">${escHtml(m.error)}</div>` : ""}
    </td>
    <td>${date}</td>
    <td>${escHtml(m.detectedByName || m.detectedByUid)}</td>
    <td title="${escHtml((m.attendeeEmails || []).join(", "))}">${attendees}</td>
    <td>${m.taskCount}</td>
    <td><span class="badge" style="background:${color}20;color:${color};">${escHtml(m.status)}</span></td>
    <td>${escHtml(formatLabel(m))}</td>
    <td>${tokens}</td>
    <td style="white-space:nowrap;">
      <button class="btn btn-ghost expand-meeting-btn" data-meeting-id="${escHtml(m.id)}"
        style="font-size:12px;padding:3px 8px;">View</button>
      ${canReprocess
        ? `<button class="btn btn-ghost reprocess-btn" data-meeting-id="${escHtml(m.id)}" data-title="${escHtml(m.meetingTitle)}"
            title="${m.status === "processing" ? "Stuck in processing" + stuckLabel : "Reprocess this meeting"}"
            style="font-size:12px;padding:3px 8px;color:#f97316;margin-left:4px;">Reprocess${escHtml(stuckLabel)}</button>`
        : ""}
    </td>
  </tr>
  <tr class="meeting-detail-row" id="detail-${escHtml(m.id)}" hidden>
    <td colspan="9" style="background:#f9fafb;padding:16px 20px;">
      <div id="proposals-${escHtml(m.id)}"><span style="color:#9ca3af;">Loading proposals…</span></div>
    </td>
  </tr>`;
}

function buildMeetingsTable(meetings) {
  if (!meetings.length) {
    return "<p style='padding:20px;color:#9ca3af;'>No meetings found.</p>";
  }
  return `<table class="admin-table" style="font-size:13px;">
    <thead><tr>
      <th>Meeting</th><th>Date</th><th>Detected By</th>
      <th>Attendees</th><th>Tasks</th><th>Status</th>
      <th>Format</th><th>Tokens</th><th>Actions</th>
    </tr></thead>
    <tbody>${meetings.map(meetingRow).join("")}</tbody>
  </table>`;
}

function renderMeetings(meetings) {
  const el = document.getElementById("meetings-list");
  el.innerHTML = buildMeetingsTable(meetings);
  attachMeetingHandlers(el);
}

function appendMeetings(meetings) {
  const el = document.getElementById("meetings-list");
  const tbody = el.querySelector("tbody");
  if (!tbody) { renderMeetings(meetings); return; }
  const tmp = document.createElement("tbody");
  tmp.innerHTML = meetings.map(meetingRow).join("");
  for (const row of tmp.children) tbody.appendChild(row);
  attachMeetingHandlers(el);
}

function attachMeetingHandlers(container) {
  // Expand/collapse proposal rows
  for (const btn of container.querySelectorAll(".expand-meeting-btn")) {
    btn.addEventListener("click", async () => {
      const mid = btn.dataset.meetingId;
      const detailRow = document.getElementById(`detail-${mid}`);
      if (!detailRow) return;
      const isHidden = detailRow.hidden;
      detailRow.hidden = !isHidden;
      btn.textContent = isHidden ? "Hide" : "View";
      if (isHidden) await loadProposals(mid);
    });
  }

  // Reprocess
  for (const btn of container.querySelectorAll(".reprocess-btn")) {
    btn.addEventListener("click", async () => {
      const mid = btn.dataset.meetingId;
      const title = btn.dataset.title;
      if (!confirm(`Reprocess "${title}"? This will re-run the AI extraction pipeline.`)) return;
      btn.disabled = true;
      btn.textContent = "Queuing…";
      try {
        await api.reprocessMeeting(mid);
        showToast("Meeting queued for reprocessing.", "success");
        meetingsLoaded = false;
        await loadMeetings();
      } catch (err) {
        showToast("Failed to reprocess: " + err.message, "error");
        btn.disabled = false;
        btn.textContent = "Reprocess";
      }
    });
  }
}

async function loadProposals(meetingId) {
  const container = document.getElementById(`proposals-${meetingId}`);
  if (!container) return;
  try {
    const { tasks } = await api.getProposalsForMeeting(meetingId);
    if (!tasks.length) {
      container.innerHTML = "<span style='color:#9ca3af;'>No proposals for this meeting.</span>";
      return;
    }
    container.innerHTML = tasks.map((t) => {
      const statusColor = { pending: "#f59e0b", approved: "#10b981", rejected: "#6b7280", created: "#3b82f6", failed: "#ef4444" }[t.status] || "#6b7280";
      return `<div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid #e5e7eb;font-size:13px;">
        <div>
          <strong>${escHtml(t.editedTitle || t.title)}</strong>
          <span style="color:#6b7280;margin-left:8px;">${escHtml(t.assigneeName || t.assigneeEmail || "")}</span>
        </div>
        <span class="badge" style="background:${statusColor}20;color:${statusColor};">${escHtml(t.status)}</span>
      </div>`;
    }).join("");
  } catch (err) {
    container.innerHTML = `<span style='color:#ef4444;'>Failed to load: ${escHtml(err.message)}</span>`;
  }
}

// ─── Export Data ──────────────────────────────────────────────────────────────

document.getElementById("export-btn")?.addEventListener("click", async () => {
  const btn = document.getElementById("export-btn");
  btn.disabled = true;
  btn.textContent = "Exporting…";
  try {
    const response = await api.exportData();
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    a.href = url;
    a.download = `taskbot-export-${ts}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Export downloaded.", "success");
  } catch (err) {
    showToast("Export failed: " + err.message, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Export Data";
  }
});

// ─── Setup Wizard ─────────────────────────────────────────────────────────────

function initSetupWizard() {
  let currentStep = 1;

  // Reveal toggles in wizard
  for (const btn of wizardEl.querySelectorAll(".reveal-btn")) {
    btn.addEventListener("click", () => {
      const input = wizardEl.querySelector(`#${btn.dataset.target}`);
      if (!input) return;
      input.type = input.type === "password" ? "text" : "password";
      btn.textContent = input.type === "password" ? "Show" : "Hide";
    });
  }

  function goToStep(n) {
    // Mark previous steps done
    for (let i = 1; i < n; i++) {
      const stepEl = wizardEl.querySelector(`.wizard-step[data-step="${i}"]`);
      if (stepEl) { stepEl.classList.remove("active"); stepEl.classList.add("done"); }
    }
    const activeStep = wizardEl.querySelector(`.wizard-step[data-step="${n}"]`);
    if (activeStep) { activeStep.classList.add("active"); activeStep.classList.remove("done"); }

    for (const pane of wizardEl.querySelectorAll(".wizard-pane")) pane.hidden = true;
    const pane = wizardEl.querySelector(`#wizard-step-${n}`);
    if (pane) pane.hidden = false;
    currentStep = n;
  }

  function showWizResult(elId, ok, msg) {
    const el = wizardEl.querySelector(`#${elId}`);
    if (!el) return;
    el.hidden = false;
    el.textContent = msg;
    el.style.color = ok ? "#16a34a" : "#ef4444";
  }

  // Step 1: AI Provider
  wizardEl.querySelector("#wiz-skip-1")?.addEventListener("click", () => goToStep(2));
  wizardEl.querySelector("#wiz-save-ai")?.addEventListener("click", async () => {
    const provider = wizardEl.querySelector("#wiz-ai-provider")?.value;
    const key = wizardEl.querySelector("#wiz-ai-key")?.value?.trim();
    if (!key) { showWizResult("wiz-ai-result", false, "Enter an API key to continue."); return; }
    try {
      await api.setAdminSecrets({ ai: { provider, apiKey: key } });
      showWizResult("wiz-ai-result", true, "✓ AI credentials saved.");
      setTimeout(() => goToStep(2), 800);
    } catch (err) {
      showWizResult("wiz-ai-result", false, "Error: " + err.message);
    }
  });

  // Step 2: Notifications
  wizardEl.querySelector("#wiz-skip-2")?.addEventListener("click", () => goToStep(3));
  wizardEl.querySelector("#wiz-save-notif")?.addEventListener("click", async () => {
    const botToken = wizardEl.querySelector("#wiz-slack-token")?.value?.trim();
    const signingSecret = wizardEl.querySelector("#wiz-slack-secret")?.value?.trim();
    if (!botToken && !signingSecret) { goToStep(3); return; }
    try {
      const slack = {};
      if (botToken) slack.botToken = botToken;
      if (signingSecret) slack.signingSecret = signingSecret;
      await api.setAdminSecrets({ slack });
      showWizResult("wiz-notif-result", true, "✓ Slack credentials saved.");
      setTimeout(() => goToStep(3), 800);
    } catch (err) {
      showWizResult("wiz-notif-result", false, "Error: " + err.message);
    }
  });

  // Step 3: Org Defaults
  wizardEl.querySelector("#wiz-skip-3")?.addEventListener("click", () => goToStep(4));
  wizardEl.querySelector("#wiz-save-defaults")?.addEventListener("click", async () => {
    const notifyVia = wizardEl.querySelector("#wiz-notify-via")?.value;
    const taskDestination = wizardEl.querySelector("#wiz-task-dest")?.value;
    const proposalExpiryHours = parseInt(wizardEl.querySelector("#wiz-expiry")?.value || "48", 10);
    try {
      await api.updateOrgDefaults({ notifyVia, taskDestination, proposalExpiryHours });
      showWizResult("wiz-defaults-result", true, "✓ Org defaults saved.");
      setTimeout(() => goToStep(4), 800);
    } catch (err) {
      showWizResult("wiz-defaults-result", false, "Error: " + err.message);
    }
  });

  // Step 4: Invite + Finish
  const invitedList = wizardEl.querySelector("#wiz-invited-list");
  wizardEl.querySelector("#wiz-send-invite")?.addEventListener("click", async () => {
    const email = wizardEl.querySelector("#wiz-invite-email")?.value?.trim();
    if (!email) return;
    try {
      await api.inviteUser(email);
      const li = document.createElement("li");
      li.textContent = `✓ Invited ${email}`;
      li.style.color = "#16a34a";
      invitedList.appendChild(li);
      wizardEl.querySelector("#wiz-invite-email").value = "";
    } catch (err) {
      showToast("Invite failed: " + err.message, "error");
    }
  });

  wizardEl.querySelector("#wiz-finish")?.addEventListener("click", async () => {
    try {
      await api.completeSetup();
      wizardEl.hidden = true;
      // Reload the admin panel properly
      window.location.reload();
    } catch (err) {
      showToast("Could not mark setup complete: " + err.message, "error");
      // Still proceed to admin panel
      wizardEl.hidden = true;
      window.location.reload();
    }
  });

  goToStep(1);
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
