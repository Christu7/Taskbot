// Shared Firebase initialization — imported by all pages.
// ES module caching ensures initializeApp() runs exactly once.

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getFirestore,
  connectFirestoreEmulator,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js";
import {
  getAuth,
  signInWithCustomToken,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyD-oZFSZo_9cHm9FegF8e_-cQJGtuLv6UM",
  authDomain: "taskbot-fb10d.web.app",
  projectId: "taskbot-fb10d",
  storageBucket: "taskbot-fb10d.firebasestorage.app",
  messagingSenderId: "997717209533",
  appId: "1:997717209533:web:3876c8dedfb2a8dfe9a2d4",
};

const firebaseApp = initializeApp(firebaseConfig);
export const db = getFirestore(firebaseApp);
export const auth = getAuth(firebaseApp);
export { signInWithCustomToken };

if (location.hostname === "127.0.0.1" || location.hostname === "localhost") {
  connectFirestoreEmulator(db, "127.0.0.1", 8080);
}
