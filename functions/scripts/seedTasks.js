/**
 * One-time seed script: adds 5 sample pending tasks for a given user.
 * Run from the project root: node scripts/seedTasks.js
 */
const admin = require("firebase-admin");

admin.initializeApp({
  credential: admin.credential.applicationDefault(),
  projectId: "taskbot-fb10d",
});

const db = admin.firestore();

const OWNER_UID = "VPnWjrN5CZQKRxZXpaJmbYjaT7k2"; // christian.tufro@elysianfields.co

const TASKS = [
  {
    title: "Send Q1 budget summary to stakeholders",
    description:
      "Compile the Q1 budget actuals vs. forecast and distribute to all department heads before the board meeting. Include variance notes for items over 10%.",
    assigneeEmail: "christian.tufro@elysianfields.co",
    confidence: "high",
    suggestedDueDate: "2026-03-07",
    isSensitive: false,
  },
  {
    title: "Schedule onboarding sessions for new engineering hire",
    description:
      "Coordinate intro meetings with product, design, and DevOps for the new backend engineer starting next Monday. Book all sessions in their first week.",
    assigneeEmail: "christian.tufro@elysianfields.co",
    confidence: "high",
    suggestedDueDate: "2026-03-06",
    isSensitive: false,
  },
  {
    title: "Review and merge open pull requests before release",
    description:
      "Three PRs are blocking the v2.4 release. Review, request changes if needed, and merge by Thursday so QA has time to run regression tests.",
    assigneeEmail: "christian.tufro@elysianfields.co",
    confidence: "high",
    suggestedDueDate: "2026-03-05",
    isSensitive: false,
  },
  {
    title: "Follow up on vendor contract renewal",
    description:
      "The SaaS vendor contract expires end of month. Reach out to confirm renewal terms and check if pricing has changed. Loop in legal if new terms are introduced.",
    assigneeEmail: "christian.tufro@elysianfields.co",
    confidence: "medium",
    suggestedDueDate: "2026-03-10",
    isSensitive: false,
  },
  {
    title: "Update team on infrastructure migration timeline",
    description:
      "The cloud migration plan was discussed but no one sent a follow-up summary. Draft a brief timeline doc and share it in the engineering Slack channel.",
    assigneeEmail: "christian.tufro@elysianfields.co",
    confidence: "medium",
    suggestedDueDate: null,
    isSensitive: false,
  },
];

async function seed() {
  const batch = db.batch();

  for (const task of TASKS) {
    const ref = db.collection("tasks").doc();
    batch.set(ref, {
      ...task,
      ownerId: OWNER_UID,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      source: "seed",
    });
  }

  await batch.commit();
  console.log(`✓ ${TASKS.length} tasks written for user ${OWNER_UID}`);
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
