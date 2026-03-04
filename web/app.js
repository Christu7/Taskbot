// ─── Firebase Configuration ───────────────────────────────────────────────────
// TODO: Replace this with your actual Firebase project config.
// Find it in: Firebase Console → Project Settings → Your Apps → SDK setup
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  connectFirestoreEmulator,
  collectionGroup,
  query,
  where,
  orderBy,
  onSnapshot,
  doc,
  updateDoc,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyD-oZFSZo_9cHm9FegF8e_-cQJGtuLv6UM",
  authDomain: "taskbot-fb10d.firebaseapp.com",
  projectId: "taskbot-fb10d",
  storageBucket: "taskbot-fb10d.firebasestorage.app",
  messagingSenderId: "997717209533",
  appId: "1:997717209533:web:3876c8dedfb2a8dfe9a2d4",
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

// Connect to local Firestore emulator in development
if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// ─── DOM References ───────────────────────────────────────────────────────────
const taskList = document.getElementById("task-list");

// ─── Render Proposals ─────────────────────────────────────────────────────────
function renderTask(docRef, task) {
  const card = document.createElement("div");
  card.className = "task-card";
  card.id = `task-${docRef.id}`;
  card.innerHTML = `
    <div class="task-info">
      <h3>${escapeHtml(task.title ?? "Untitled Task")}</h3>
      <p>${escapeHtml(task.description ?? "No description provided.")}</p>
    </div>
    <div class="task-actions">
      <button class="btn btn-approve" data-path="${docRef.path}">Approve</button>
      <button class="btn btn-reject"  data-path="${docRef.path}">Reject</button>
    </div>
  `;
  taskList.appendChild(card);
}

// ─── Real-time Listener for Pending Proposals ─────────────────────────────────
// Queries the proposals/{meetingId}/tasks/ subcollection via a collection group
// query, filtered to this user's pending proposals ordered newest first.
function listenForPendingTasks(uid) {
  const q = query(
    collectionGroup(db, "tasks"),
    where("assigneeUid", "==", uid),
    where("status", "==", "pending"),
    orderBy("createdAt", "desc")
  );

  return onSnapshot(q, (snapshot) => {
    taskList.innerHTML = "";

    if (snapshot.empty) {
      taskList.innerHTML = '<p class="empty-state">No pending tasks — you\'re all caught up!</p>';
      return;
    }

    snapshot.forEach((docSnap) => {
      renderTask(docSnap.ref, docSnap.data());
    });
  }, (err) => {
    console.error("Task listener error:", err);
    taskList.innerHTML = '<p class="empty-state">Failed to load tasks. Check the console for details.</p>';
  });
}

// ─── Approve / Reject Handlers ────────────────────────────────────────────────
taskList.addEventListener("click", async (e) => {
  const btn = e.target.closest(".btn");
  if (!btn) return;

  const path = btn.dataset.path;
  const action = btn.classList.contains("btn-approve") ? "approved" : "rejected";

  try {
    await updateDoc(doc(db, path), { status: action });
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

// ─── Auth UI ──────────────────────────────────────────────────────────────────
const loginBtn = document.getElementById("login-btn");
const logoutBtn = document.getElementById("logout-btn");
const connectBtn = document.getElementById("connect-btn");
const userInfo = document.getElementById("user-info");
const userName = document.getElementById("user-name");
const pendingTasks = document.getElementById("pending-tasks");
const loginPrompt = document.getElementById("login-prompt");

let unsubscribeTasks = null;

loginBtn.addEventListener("click", () => {
  signInWithPopup(auth, new GoogleAuthProvider());
});

logoutBtn.addEventListener("click", () => {
  signOut(auth);
});

connectBtn.addEventListener("click", async () => {
  const token = await auth.currentUser.getIdToken();
  const base = location.hostname === "127.0.0.1" || location.hostname === "localhost"
    ? "http://127.0.0.1:5001/taskbot-fb10d/us-central1"
    : "https://us-central1-taskbot-fb10d.cloudfunctions.net";
  window.location.href = `${base}/oauthInit?token=${token}`;
});

// ─── Boot ─────────────────────────────────────────────────────────────────────
onAuthStateChanged(auth, (user) => {
  if (user) {
    loginBtn.hidden = true;
    userInfo.hidden = false;
    userName.textContent = user.displayName || user.email;
    pendingTasks.hidden = false;
    loginPrompt.hidden = true;

    if (!unsubscribeTasks) {
      unsubscribeTasks = listenForPendingTasks(user.uid);
    }
  } else {
    loginBtn.hidden = false;
    userInfo.hidden = true;
    pendingTasks.hidden = true;
    loginPrompt.hidden = false;

    if (unsubscribeTasks) {
      unsubscribeTasks();
      unsubscribeTasks = null;
    }
  }
});
