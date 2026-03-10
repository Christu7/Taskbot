/**
 * Seeds the config/orgDefaults Firestore document with default org-level settings.
 * Safe to run multiple times — uses `set` with merge so existing overrides are preserved.
 *
 * Run with:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json \
 *   npx ts-node --project scripts/tsconfig.json scripts/seedOrgDefaults.ts
 */

import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

async function seed(): Promise<void> {
  const ref = db.collection("config").doc("orgDefaults");

  await ref.set(
    {
      taskDestination: "google_tasks",
      notifyVia: "email",
    },
    { merge: true }
  );

  console.log("config/orgDefaults written successfully.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
