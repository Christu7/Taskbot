/**
 * One-time migration: converts proposal documents that use the old
 * `googleTaskId` string field into the new `externalRefs` array format.
 *
 * Run with:
 *   GOOGLE_APPLICATION_CREDENTIALS=/path/to/serviceAccount.json \
 *   npx ts-node --project scripts/tsconfig.json scripts/migrateGoogleTaskId.ts
 *
 * Safe to run multiple times — documents that already have `externalRefs`
 * are skipped.
 */

import * as admin from "firebase-admin";

admin.initializeApp();
const db = admin.firestore();

async function migrate(): Promise<void> {
  console.log("Starting googleTaskId → externalRefs migration…");

  // Fetch all proposal sub-collection documents that still have googleTaskId
  // Firestore doesn't support collectionGroup queries across dynamically-named
  // sub-collections easily, so we iterate top-level proposals docs first.
  const meetingsSnap = await db.collection("proposals").listDocuments();
  console.log(`Found ${meetingsSnap.length} meeting(s) in proposals collection.`);

  let migrated = 0;
  let skipped = 0;

  for (const meetingRef of meetingsSnap) {
    const tasksSnap = await meetingRef.collection("tasks").get();
    for (const doc of tasksSnap.docs) {
      const data = doc.data();

      // Already migrated
      if (Array.isArray(data.externalRefs) && data.externalRefs.length > 0) {
        skipped++;
        continue;
      }

      // Nothing to migrate
      if (!data.googleTaskId) {
        skipped++;
        continue;
      }

      const externalRefs = [
        {
          destination: "google_tasks",
          externalId: data.googleTaskId as string,
          externalUrl: "https://tasks.google.com/",
        },
      ];

      await doc.ref.update({ externalRefs });
      console.log(`  Migrated ${meetingRef.id}/${doc.id} — googleTaskId: ${data.googleTaskId}`);
      migrated++;
    }
  }

  console.log(`\nMigration complete. Migrated: ${migrated}, Skipped: ${skipped}`);
  process.exit(0);
}

migrate().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
