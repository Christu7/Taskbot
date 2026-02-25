// ─── Firebase Configuration ───────────────────────────────────────────────────
// TODO: Replace this with your actual Firebase project config.
// Find it in: Firebase Console → Project Settings → Your Apps → SDK setup
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  collection,
  query,
  where,
  onSnapshot,
  doc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// ─── DOM References ───────────────────────────────────────────────────────────
const taskList = document.getElementById("task-list");

// ─── Render Tasks ─────────────────────────────────────────────────────────────
function renderTask(id, task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.id = `task-${id}`;
  card.innerHTML = `
    <div class="task-info">
      <h3>${escapeHtml(task.title ?? "Untitled Task")}</h3>
      <p>${escapeHtml(task.description ?? "No description provided.")}</p>
    </div>
    <div class="task-actions">
      <button class="btn btn-approve" data-id="${id}">Approve</button>
      <button class="btn btn-reject"  data-id="${id}">Reject</button>
    </div>
  `;
  taskList.appendChild(card);
}

// ─── Real-time Listener for Pending Tasks ─────────────────────────────────────
function listenForPendingTasks() {
  const q = query(
    collection(db, "tasks"),
    where("status", "==", "pending")
  );

  onSnapshot(q, (snapshot) => {
    taskList.innerHTML = "";

    if (snapshot.empty) {
      taskList.innerHTML = '<p class="empty-state">No pending tasks — you\'re all caught up!</p>';
      return;
    }

    snapshot.forEach((docSnap) => {
      renderTask(docSnap.id, docSnap.data());
    });
  });
}

// ─── Approve / Reject Handlers ────────────────────────────────────────────────
taskList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn");
  if (!btn) return;

  const taskId = btn.dataset.id;
  const action = btn.classList.contains("btn-approve") ? "approved" : "rejected";

  try {
    await updateDoc(doc(db, "tasks", taskId), { status: action });
    console.log(`Task ${taskId} marked as ${action}`);
  } catch (err) {
    console.error("Error updating task:", err);
    alert("Failed to update task. Check the console for details.");
  }
});

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  return str.replace(/[&<>"']/g, (m) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[m]));
}

// ─── Boot ─────────────────────────────────────────────────────────────────────
listenForPendingTasks();
