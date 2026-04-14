/**
 * One-time backfill: populates missing `email` and `orgId` fields on
 * users/{uid} documents that were created before these fields were added.
 *
 * Run from the functions/ directory:
 *   cd functions
 *   node ../scripts/backfill-user-fields.js
 *
 * Requires application default credentials:
 *   gcloud auth application-default login
 */

"use strict";

const path = require("path");
// firebase-admin lives in functions/node_modules — resolve from this script's location
const admin = require(path.join(__dirname, "../functions/node_modules/firebase-admin"));

admin.initializeApp({ projectId: "lithe-bonito-490017-s8" });

const db = admin.firestore();

async function run() {
  const usersSnap = await db.collection("users").get();

  let checked = 0;
  let updated = 0;
  let skipped = 0;

  for (const doc of usersSnap.docs) {
    checked++;
    const uid = doc.id;
    const data = doc.data();

    // Skip if both fields are already present and non-empty
    if (data.orgId && data.email) continue;

    // ── 1. Resolve email from Firebase Auth ───────────────────────────────
    let email = data.email || undefined;
    if (!email) {
      try {
        const authUser = await admin.auth().getUser(uid);
        email = authUser.email;
      } catch (err) {
        console.warn(`[SKIP] uid=${uid} — could not fetch Auth record: ${err.message}`);
        skipped++;
        continue;
      }
    }

    if (!email) {
      console.warn(`[SKIP] uid=${uid} — Auth record has no email address`);
      skipped++;
      continue;
    }

    // ── 2. Derive orgId from the email domain ─────────────────────────────
    let orgId = data.orgId || undefined;
    if (!orgId) {
      const domain = email.split("@")[1];
      if (!domain) {
        console.warn(`[SKIP] uid=${uid} email=${email} — cannot extract domain`);
        skipped++;
        continue;
      }

      const orgSnap = await db
        .collection("organizations")
        .where("allowedDomains", "array-contains", domain)
        .where("isActive", "==", true)
        .limit(1)
        .get();

      if (orgSnap.empty) {
        console.warn(`[SKIP] uid=${uid} email=${email} — no active org for domain "${domain}"`);
        skipped++;
        continue;
      }

      orgId = orgSnap.docs[0].id;
    }

    // ── 3. Write the resolved fields ──────────────────────────────────────
    await db.collection("users").doc(uid).set(
      {
        email,
        orgId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    console.log(`[OK] uid=${uid} email=${email} orgId=${orgId}`);
    updated++;
  }

  console.log(`\nDone. checked=${checked} updated=${updated} skipped=${skipped}`);
}

run().catch((err) => {
  console.error("Fatal error:", err.message);
  process.exit(1);
});
