/**
 * One-time script: creates a processedTranscripts document with status "pending"
 * to manually trigger the processTranscript Cloud Function for testing.
 *
 * Usage: GOOGLE_APPLICATION_CREDENTIALS=<key.json> node scripts/seedTranscript.js
 */
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "taskbot-fb10d",
});

const db = admin.firestore();

// The Drive file ID from the transcript detected earlier
const DRIVE_FILE_ID = "1oduLFrakWl5t7Bb_fUy84eXP2oR51Trkzgl3kvzIYl0";
const DETECTED_BY_UID = "VPnWjrN5CZQKRxZXpaJmbYjaT7k2";

async function seed() {
  const docRef = db.collection("processedTranscripts").doc(DRIVE_FILE_ID);

  // Delete any existing doc first so the onCreate trigger fires cleanly
  await docRef.delete();
  console.log("Deleted existing doc (if any)");

  await docRef.set({
    driveFileId: DRIVE_FILE_ID,
    driveFileLink: `https://docs.google.com/document/d/${DRIVE_FILE_ID}/edit`,
    detectedByUid: DETECTED_BY_UID,
    meetingTitle: "rrz-warm-zyx (2026-03-03 13:41 GMT-3) \u2013 Transcript",
    detectedAt: admin.firestore.FieldValue.serverTimestamp(),
    status: "pending",
    attendeeEmails: ["christian.tufro@elysianfields.co"],
  });

  console.log(`✓ processedTranscripts/${DRIVE_FILE_ID} created with status "pending"`);
  console.log("Watch Firestore — processTranscript should fire within seconds.");
  process.exit(0);
}

seed().catch((err) => {
  console.error("Failed:", err.message);
  process.exit(1);
});
