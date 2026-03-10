// Shared auth utilities used by every page.

import {
  GoogleAuthProvider,
  signInWithRedirect,
  getRedirectResult,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js";
import { auth, signInWithCustomToken } from "./firebase-config.js";

export { auth, signInWithCustomToken };

/** Trigger Google sign-in via full-page redirect (more reliable than popup). */
export function signInWithGoogle() {
  return signInWithRedirect(auth, new GoogleAuthProvider());
}

/**
 * Call once at page load on the login page to handle the result of a redirect sign-in.
 * Resolves with the UserCredential if returning from a redirect, or null otherwise.
 */
export function handleRedirectResult() {
  return getRedirectResult(auth);
}

/** Sign out the current user and clear cached role state. */
export async function signOutUser() {
  sessionStorage.removeItem("userRole");
  await signOut(auth);
  window.location.href = "/";
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

/**
 * Fetch and cache the current user's role ("admin" | "user").
 * Cached in sessionStorage so subsequent calls are instant.
 * Falls back to "user" on any error.
 */
export async function getUserRole() {
  const cached = sessionStorage.getItem("userRole");
  if (cached) return cached;
  try {
    const { api } = await import("./api.js");
    const settings = await api.getSettings();
    const role = settings.role ?? "user";
    sessionStorage.setItem("userRole", role);
    return role;
  } catch {
    return "user";
  }
}

/**
 * Show the Admin nav link if the current user is an admin.
 * Looks for an element with id="admin-link" on the page.
 */
export async function initAdminNav() {
  const role = await getUserRole();
  const link = document.getElementById("admin-link");
  if (link && role === "admin") link.hidden = false;
}

/**
 * Guard: redirect non-admin users to the dashboard.
 * Returns true if the user may proceed, false if they were redirected.
 */
export async function requireAdminRole() {
  const role = await getUserRole();
  if (role !== "admin") {
    window.location.href = "/dashboard";
    return false;
  }
  return true;
}

/** Show a brief toast notification. */
export function showToast(message, type = "") {
  const el = document.createElement("div");
  el.className = `toast${type ? " " + type : ""}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3500);
}
