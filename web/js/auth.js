// Shared auth utilities used by every page.

import {
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, signInWithCustomToken } from "./firebase-config.js";

export { auth, signInWithCustomToken };

/** Trigger Google sign-in popup. */
export function signInWithGoogle() {
  return signInWithPopup(auth, new GoogleAuthProvider());
}

/** Sign out the current user. */
export function signOutUser() {
  return signOut(auth);
}

/**
 * Wait for Firebase Auth to initialise and return the current user (or null).
 * Useful at page load to avoid flickering before auth state is known.
 */
export function waitForAuthReady() {
  return new Promise((resolve) => {
    const unsub = onAuthStateChanged(auth, (user) => {
      unsub();
      resolve(user);
    });
  });
}

/**
 * Guard: redirect unauthenticated users to the login page.
 * Returns the current user so callers can use it immediately.
 */
export async function requireAuth() {
  const user = await waitForAuthReady();
  if (!user) {
    window.location.href = "/";
    return null;
  }
  return user;
}

/** Show a brief toast notification. */
export function showToast(message, type = "") {
  const el = document.createElement("div");
  el.className = `toast${type ? " " + type : ""}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
