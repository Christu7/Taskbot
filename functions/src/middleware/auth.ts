import * as admin from "firebase-admin";
import { Request, Response, NextFunction } from "express";
import { getUser } from "../services/firestore";

/** Express Request augmented with the verified Firebase UID. */
export interface AuthRequest extends Request {
  uid: string;
}

/**
 * Express middleware: verifies the Firebase ID token in the Authorization
 * header and attaches `uid` to the request object.
 *
 * Returns 401 if the header is missing or the token is invalid/expired.
 */
export async function requireAuth(
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

/**
 * Express middleware: verifies the current user has role "admin".
 * Must be used AFTER `requireAuth` (relies on `req.uid` being set).
 *
 * Returns 403 if the user is not found or their role is not "admin".
 */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const uid = (req as AuthRequest).uid;
  const user = await getUser(uid);
  if (!user || user.role !== "admin") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}
