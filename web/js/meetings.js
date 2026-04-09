import { requireAuth, signOutUser, showToast, initAdminNav } from "./auth.js";
import { api } from "./api.js";

const loadingEl   = document.getElementById("loading");
const errorEl     = document.getElementById("error-state");
const emptyEl     = document.getElementById("empty-state");
const tableWrapEl = document.getElementById("table-wrap");
const tbodyEl     = document.getElementById("meetings-tbody");
const chipEl      = document.getElementById("user-chip");
const logoutBtn   = document.getElementById("logout-btn");

// ─── Insights modal elements ──────────────────────────────────────────────────

const insightsModal      = document.getElementById("insights-modal");
const insightsModalBox   = document.getElementById("insights-modal-box");
const insightsModalTitle = document.getElementById("insights-modal-title");
const insightsModalBody  = document.getElementById("insights-modal-body");
const insightsModalClose = document.getElementById("insights-modal-close");

function openInsightsModal(meetingTitle, themes) {
  insightsModalTitle.textContent = meetingTitle + " — Insights";
  insightsModalBody.innerHTML = themes.map((t) => `
    <div style="margin-bottom:18px;">
      <div style="font-weight:600;font-size:13px;color:#111827;margin-bottom:4px;">${esc(t.title)}</div>
      <div style="font-size:13px;color:#374151;line-height:1.55;">${esc(t.summary)}</div>
    </div>
  `).join('<hr style="border:none;border-top:1px solid #f3f4f6;margin:0 0 18px;">');
  insightsModal.hidden = false;
  insightsModalClose.focus();
}

function closeInsightsModal() {
  insightsModal.hidden = true;
  insightsModalBody.innerHTML = "";
}

// Close on backdrop click
insightsModal.addEventListener("click", (e) => {
  if (e.target === insightsModal) closeInsightsModal();
});

// Close on ✕ button
insightsModalClose.addEventListener("click", closeInsightsModal);

// ESC to close + focus trap
insightsModal.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeInsightsModal(); return; }
  if (e.key !== "Tab") return;
  // Focus trap: keep focus inside modal box
  const focusable = Array.from(insightsModalBox.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
  ));
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last  = focusable[focusable.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault(); last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault(); first.focus();
  }
});

// ─── Boot ─────────────────────────────────────────────────────────────────────

const user = await requireAuth();
if (!user) throw new Error("not reached");

chipEl.textContent = user.displayName || user.email;
logoutBtn.addEventListener("click", () => signOutUser());
initAdminNav();

// ─── Load ──────────────────────────────────────────────────────────────────────

try {
  const { meetings } = await api.getMyMeetings();

  loadingEl.hidden = true;

  if (!meetings || meetings.length === 0) {
    emptyEl.hidden = false;
  } else {
    for (const meeting of meetings) {
      tbodyEl.appendChild(renderRow(meeting));
    }
    tableWrapEl.hidden = false;
  }
} catch (err) {
  loadingEl.hidden = true;
  errorEl.textContent = "Failed to load meetings: " + (err.message || "Unknown error");
  errorEl.hidden = false;
}

// ─── Render ───────────────────────────────────────────────────────────────────

function renderRow(meeting) {
  const tr = document.createElement("tr");
  const title = meeting.meetingTitle || meeting.id;
  const date  = formatDate(meeting.detectedAt);

  // Insights state drives button visibility
  // - insightsProcessed: hide Process, show active View
  // - not processed: show active Process, show disabled View
  const hasInsights = !!meeting.insightsProcessed;

  tr.innerHTML = `
    <td class="meeting-title">${esc(title)}</td>
    <td class="meeting-date">${date}</td>
    <td>${statusBadge(meeting.status)}${hasInsights ? ' <span class="status-badge" style="background:#f3e8ff;color:#7c3aed;">✦ Insights</span>' : ""}</td>
    <td class="actions-cell">
      <button class="btn btn-ghost" style="font-size:12px;padding:4px 10px;"
              data-action="view-insights"
              ${hasInsights ? "" : "disabled"}>
        View Insights
      </button>
      <button class="btn btn-ghost" style="font-size:12px;padding:4px 10px;${hasInsights ? "display:none;" : ""}"
              data-action="process-insights">
        Process for Insights
      </button>
    </td>
  `;

  // View Insights — open modal with cached themes if we have them,
  // otherwise fetch from the API (covers page-reload after processing)
  tr.querySelector("[data-action='view-insights']")?.addEventListener("click", async (e) => {
    const btn = e.currentTarget;
    if (meeting._cachedThemes) {
      openInsightsModal(title, meeting._cachedThemes);
      return;
    }
    btn.disabled = true;
    btn.textContent = "Loading…";
    try {
      const { insights } = await api.processInsights(meeting.id);
      meeting._cachedThemes = insights;
      openInsightsModal(title, insights);
    } catch (err) {
      showToast("Failed to load insights: " + (err.message || "Unknown error"), "error");
    } finally {
      btn.disabled = false;
      btn.textContent = "View Insights";
    }
  });

  // Process for Insights — call AI, then swap button states
  tr.querySelector("[data-action='process-insights']")?.addEventListener("click", async (e) => {
    const processBtn = e.currentTarget;
    const viewBtn    = tr.querySelector("[data-action='view-insights']");

    processBtn.disabled = true;
    processBtn.innerHTML = '<span class="loading-spinner" style="width:12px;height:12px;border-width:2px;vertical-align:middle;margin-right:4px;"></span>Processing…';

    try {
      const { insights } = await api.processInsights(meeting.id);
      meeting._cachedThemes = insights;
      meeting.insightsProcessed = true;

      // Update row: show badge, hide Process button, enable View button
      const statusCell = tr.querySelector("td:nth-child(3)");
      if (statusCell && !statusCell.querySelector("[style*='7c3aed']")) {
        statusCell.insertAdjacentHTML(
          "beforeend",
          ' <span class="status-badge" style="background:#f3e8ff;color:#7c3aed;">✦ Insights</span>'
        );
      }
      processBtn.style.display = "none";
      if (viewBtn) { viewBtn.disabled = false; }

      showToast("Insights processed successfully.", "success");
    } catch (err) {
      showToast(
        err.message?.includes("not available")
          ? "Transcript text is not available for this meeting."
          : "Failed to process insights: " + (err.message || "Unknown error"),
        "error"
      );
      processBtn.disabled = false;
      processBtn.textContent = "Process for Insights";
    }
  });

  return tr;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function statusBadge(status) {
  const cls = ["pending", "processing", "extracting", "dedup_pending", "deduplicating"].includes(status)
    ? "status-pending"
    : status === "proposed"   ? "status-proposed"
    : status === "completed"  ? "status-completed"
    : status === "failed"     ? "status-failed"
    : "status-unknown";
  return `<span class="status-badge ${cls}">${esc(status ?? "unknown")}</span>`;
}

function formatDate(ts) {
  if (!ts) return "—";
  let ms;
  if (typeof ts === "number") {
    ms = ts;
  } else if (typeof ts === "string") {
    ms = Date.parse(ts);
  } else if (ts._seconds !== undefined) {
    ms = ts._seconds * 1000;
  } else if (ts.seconds !== undefined) {
    ms = ts.seconds * 1000;
  }
  if (!ms || isNaN(ms)) return "—";
  return new Date(ms).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric", year: "numeric",
  });
}

function esc(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}
