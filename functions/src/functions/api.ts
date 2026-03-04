import * as admin from "firebase-admin";
import { onRequest } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { FieldValue } from "firebase-admin/firestore";
import express, { Request, Response, NextFunction } from "express";
import { validateApprovalToken, markApprovalTokenUsed } from "../services/approvalTokens";
import { getUser, updateUser } from "../services/firestore";
import { ProposalDocument } from "../models/proposal";
import { UserPreferences } from "../models/user";

const db = () => admin.firestore();

// ─── Express App ──────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());

// Normalize path: strip /api prefix when request arrives via Firebase Hosting
// rewrite (which preserves the full path, unlike direct function invocation).
app.use((req: Request, _res: Response, next: NextFunction) => {
  if (req.path.startsWith("/api/") || req.path === "/api") {
    req.url = req.url.replace(/^\/api/, "") || "/";
  }
  next();
});

// ─── Auth Middleware ──────────────────────────────────────────────────────────

interface AuthRequest extends Request {
  uid: string;
}

async function authenticate(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  try {
    const token = authHeader.slice(7);
    const decoded = await admin.auth().verifyIdToken(token);
    (req as AuthRequest).uid = decoded.uid;
    next();
  } catch {
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ─── POST /auth/validate-token ────────────────────────────────────────────────
// Validates an email approval token (single-use, time-limited) and returns:
//   - A Firebase custom auth token so the client can sign in without a Google popup
//   - All proposals for the meeting assigned to this user
// Designed for email click-through flows where the user is not yet signed in.

app.post("/auth/validate-token", async (req: Request, res: Response) => {
  const { token } = req.body as { token?: string };
  if (!token) {
    res.status(400).json({ error: "Missing token in request body" });
    return;
  }

  try {
    const { uid, meetingId } = await validateApprovalToken(token);

    const [proposalsSnap, transcriptSnap] = await Promise.all([
      db()
        .collection("proposals").doc(meetingId).collection("tasks")
        .where("assigneeUid", "==", uid)
        .get(),
      db().collection("processedTranscripts").doc(meetingId).get(),
    ]);

    const proposals = proposalsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const meetingTitle = transcriptSnap.data()?.meetingTitle ?? meetingId;
    const driveFileLink = transcriptSnap.data()?.driveFileLink ?? null;

    // Create a short-lived custom Firebase token for the client to sign in with
    const customToken = await admin.auth().createCustomToken(uid);

    // Mark the approval token as used — client is now signed in via Firebase
    await markApprovalTokenUsed(token);

    res.json({ customToken, meetingId, meetingTitle, driveFileLink, proposals });
  } catch (err) {
    logger.warn("validate-token failed", { error: (err as Error).message });
    res.status(400).json({ error: (err as Error).message });
  }
});

// ─── GET /proposals/pending ───────────────────────────────────────────────────
// Returns all pending proposals for the authenticated user, grouped by meeting.
// Used by the dashboard to show the list of meetings awaiting review.

app.get("/proposals/pending", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;

  const snap = await db().collectionGroup("tasks")
    .where("assigneeUid", "==", uid)
    .where("status", "==", "pending")
    .orderBy("createdAt", "desc")
    .get();

  // Group by meetingId
  const grouped: Record<string, {
    meetingId: string;
    meetingTitle: string;
    driveFileLink: string;
    proposals: object[];
  }> = {};

  for (const docSnap of snap.docs) {
    const data = docSnap.data() as ProposalDocument;
    if (!grouped[data.meetingId]) {
      grouped[data.meetingId] = {
        meetingId: data.meetingId,
        meetingTitle: "",
        driveFileLink: "",
        proposals: [],
      };
    }
    grouped[data.meetingId].proposals.push({ id: docSnap.id, ...data });
  }

  // Enrich with meeting titles and Drive links from processedTranscripts
  await Promise.all(
    Object.keys(grouped).map(async (meetingId) => {
      const transcriptSnap = await db()
        .collection("processedTranscripts").doc(meetingId).get();
      grouped[meetingId].meetingTitle =
        transcriptSnap.data()?.meetingTitle ?? meetingId;
      grouped[meetingId].driveFileLink =
        transcriptSnap.data()?.driveFileLink ?? "";
    })
  );

  res.json({ meetings: Object.values(grouped) });
});

// ─── GET /proposals ───────────────────────────────────────────────────────────
// Returns all proposals for a specific meeting for the authenticated user.
// Used by the review page when navigating from the dashboard (already signed in).

app.get("/proposals", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const meetingId = req.query.meetingId as string;

  if (!meetingId) {
    res.status(400).json({ error: "Missing meetingId query parameter" });
    return;
  }

  const [proposalsSnap, transcriptSnap] = await Promise.all([
    db()
      .collection("proposals").doc(meetingId).collection("tasks")
      .where("assigneeUid", "==", uid)
      .get(),
    db().collection("processedTranscripts").doc(meetingId).get(),
  ]);

  const proposals = proposalsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const meetingTitle = transcriptSnap.data()?.meetingTitle ?? meetingId;
  const driveFileLink = transcriptSnap.data()?.driveFileLink ?? "";

  res.json({ meetingId, meetingTitle, driveFileLink, proposals });
});

// ─── GET /proposals/:meetingId/:taskId ───────────────────────────────────────
// Returns a single proposal by ID.
// Used by the review page to poll for status changes after the user approves
// a task (the taskCreator function runs asynchronously in the background).

app.get(
  "/proposals/:meetingId/:taskId",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId, taskId } = req.params;

    const docRef = db()
      .collection("proposals")
      .doc(meetingId)
      .collection("tasks")
      .doc(taskId);

    const snap = await docRef.get();

    if (!snap.exists) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    if (snap.data()?.assigneeUid !== uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    res.json({ id: snap.id, ...snap.data() });
  }
);

// ─── PATCH /proposals/:meetingId/bulk ────────────────────────────────────────
// Bulk-approves or bulk-rejects all pending proposals for a meeting.
// Defined before /:taskId to prevent "bulk" being matched as a taskId.

app.patch(
  "/proposals/:meetingId/bulk",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId } = req.params;
    const { action } = req.body as { action?: "approve" | "reject" };

    if (action !== "approve" && action !== "reject") {
      res.status(400).json({ error: "action must be 'approve' or 'reject'" });
      return;
    }

    const status = action === "approve" ? "approved" : "rejected";

    const snap = await db()
      .collection("proposals").doc(meetingId).collection("tasks")
      .where("assigneeUid", "==", uid)
      .where("status", "==", "pending")
      .get();

    if (snap.empty) {
      res.json({ updated: 0 });
      return;
    }

    const batch = db().batch();
    snap.docs.forEach((d) => {
      batch.update(d.ref, { status, reviewedAt: FieldValue.serverTimestamp() });
    });
    await batch.commit();

    logger.info(
      `bulk ${action}: ${snap.size} proposal(s) for meeting ${meetingId} by user ${uid}`
    );
    res.json({ updated: snap.size });
  }
);

// ─── PATCH /proposals/:meetingId/:taskId ─────────────────────────────────────
// Approves, rejects, or edits (then approves) a single proposal.
// When status is "edited", the server saves editedTitle/editedDescription and
// marks the proposal as "approved" (editing implies acceptance).

app.patch(
  "/proposals/:meetingId/:taskId",
  authenticate,
  async (req: Request, res: Response) => {
    const uid = (req as AuthRequest).uid;
    const { meetingId, taskId } = req.params;
    const { status, title, description, dueDate } = req.body as {
      status?: string;
      title?: string;
      description?: string;
      dueDate?: string | null;
    };

    const validStatuses = ["approved", "rejected", "edited"];
    if (!status || !validStatuses.includes(status)) {
      res
        .status(400)
        .json({ error: `status must be one of: ${validStatuses.join(", ")}` });
      return;
    }

    const docRef = db()
      .collection("proposals")
      .doc(meetingId)
      .collection("tasks")
      .doc(taskId);
    const snap = await docRef.get();

    if (!snap.exists) {
      res.status(404).json({ error: "Proposal not found" });
      return;
    }

    if (snap.data()?.assigneeUid !== uid) {
      res.status(403).json({ error: "Forbidden" });
      return;
    }

    const update: Record<string, unknown> = {
      reviewedAt: FieldValue.serverTimestamp(),
    };

    if (status === "edited") {
      // Editing implies approval — store edited fields, mark as approved
      update.status = "approved";
      if (title !== undefined) update.editedTitle = title;
      if (description !== undefined) update.editedDescription = description;
    } else {
      update.status = status;
    }

    // Store user-edited due date if provided (null clears any previously set value)
    if (dueDate !== undefined) update.editedDueDate = dueDate;

    await docRef.update(update);

    logger.info(
      `proposal ${status}: ${taskId} in meeting ${meetingId} by user ${uid}`
    );
    res.json({ success: true });
  }
);

// ─── GET /settings ────────────────────────────────────────────────────────────

app.get("/settings", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const user = await getUser(uid);
  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  res.json(user);
});

// ─── PATCH /settings ──────────────────────────────────────────────────────────

app.patch("/settings", authenticate, async (req: Request, res: Response) => {
  const uid = (req as AuthRequest).uid;
  const { isActive, preferences } = req.body as {
    isActive?: boolean;
    preferences?: Partial<UserPreferences>;
  };

  const update: Record<string, unknown> = {};

  if (isActive !== undefined) {
    if (typeof isActive !== "boolean") {
      res.status(400).json({ error: "isActive must be a boolean" });
      return;
    }
    update.isActive = isActive;
  }

  if (preferences !== undefined) {
    const allowed: (keyof UserPreferences)[] = [
      "notifyVia",
      "autoApprove",
      "proposalExpiryHours",
    ];
    for (const key of Object.keys(preferences) as (keyof UserPreferences)[]) {
      if (!allowed.includes(key)) {
        res.status(400).json({ error: `Unknown preference: ${key}` });
        return;
      }
      update[`preferences.${key}`] = preferences[key as keyof UserPreferences];
    }
  }

  if (Object.keys(update).length === 0) {
    res.status(400).json({ error: "Nothing to update" });
    return;
  }

  await updateUser(uid, update as Parameters<typeof updateUser>[1]);
  res.json({ success: true });
});

// ─── Export ───────────────────────────────────────────────────────────────────

export const api = onRequest({ region: "us-central1", cors: true }, app);
