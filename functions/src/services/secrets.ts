/**
 * High-level secrets service.
 *
 * This is the ONLY entry point other code should use for credentials.
 * Reads from Firestore (config/secrets), decrypts with KMS, and caches
 * decrypted values in memory for the lifetime of the Cloud Function instance.
 *
 * Resolution chain for any secret key:
 *   1. In-memory cache (fastest — hits on warm instances)
 *   2. Firestore config/secrets document (decrypted via KMS on first load)
 *   3. Environment variables (fallback for fresh deployments before admin setup)
 *   4. Throws "Secret not found" if none of the above have the value
 */

import * as admin from "firebase-admin";
import { Timestamp } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { encrypt, decrypt } from "./kms";

// ─── Module-level cache ───────────────────────────────────────────────────────
// Persists across warm invocations (~5-15 min). Reset on cold start.
// NEVER export these — they must not be readable from outside this module.
const cache = new Map<string, string>();
let cacheLoaded = false;
let cacheLoadedAt = 0;

/**
 * How long a loaded cache is considered fresh.
 *
 * Secrets are written by the `api` Cloud Run instance and read by `processTranscript`
 * (a separate instance). The write-side already calls cache.clear() via setSecrets(),
 * but that only flushes the local instance. The TTL ensures other instances reload
 * from Firestore within this window after an admin updates credentials.
 *
 * 5 minutes is short enough to feel immediate in practice and avoids stale-key
 * errors after a provider switch (Anthropic → OpenAI or vice versa).
 */
const CACHE_TTL_MS = 5 * 60 * 1000;

// ─── Schema ───────────────────────────────────────────────────────────────────

interface SecretsDoc {
  ai?: {
    provider?: string;   // NOT encrypted (e.g. "anthropic" | "openai")
    apiKey?: string;     // encrypted
  };
  slack?: {
    botToken?: string;       // encrypted
    signingSecret?: string;  // encrypted
    clientId?: string;       // NOT encrypted
    clientSecret?: string;   // encrypted
  };
  asana?: {
    clientId?: string;     // NOT encrypted
    clientSecret?: string; // encrypted
  };
  configuredAt?: Timestamp;
  configuredBy?: string;
}

/** Fields that are stored encrypted in Firestore and decrypted via KMS. */
const ENCRYPTED_FIELDS = [
  "ai.apiKey",
  "slack.botToken",
  "slack.signingSecret",
  "slack.clientSecret",
  "asana.clientSecret",
];

/** Fields stored in plain text (not sensitive on their own). */
const PLAIN_FIELDS = [
  "ai.provider",
  "slack.clientId",
  "asana.clientId",
];

// ─── Dot-notation helpers ─────────────────────────────────────────────────────

function getNestedField(obj: Record<string, unknown>, path: string): string | undefined {
  const [head, ...rest] = path.split(".");
  const val = obj[head];
  if (rest.length === 0) return typeof val === "string" ? val : undefined;
  if (typeof val === "object" && val !== null) {
    return getNestedField(val as Record<string, unknown>, rest.join("."));
  }
  return undefined;
}

function setNestedField(obj: Record<string, unknown>, path: string, value: unknown): void {
  const [head, ...rest] = path.split(".");
  if (rest.length === 0) {
    obj[head] = value;
    return;
  }
  if (typeof obj[head] !== "object" || obj[head] === null) {
    obj[head] = {};
  }
  setNestedField(obj[head] as Record<string, unknown>, rest.join("."), value);
}

// ─── Internal: load from Firestore ────────────────────────────────────────────

async function loadSecretsFromFirestore(): Promise<void> {
  const doc = await admin.firestore().doc("config/secrets").get();
  if (!doc.exists) return; // No secrets yet — env var fallback handles this

  const data = doc.data() as Record<string, unknown>;

  // Decrypt encrypted fields and populate cache
  for (const field of ENCRYPTED_FIELDS) {
    const value = getNestedField(data, field);
    if (value) {
      try {
        const decrypted = await decrypt(value);
        cache.set(field, decrypted);
      } catch (err) {
        // Log without the field value — do not cache; env var fallback may cover it
        logger.error(`secrets: failed to decrypt field "${field}"`, {
          error: (err as Error).message,
        });
      }
    }
  }

  // Plain fields go straight to cache
  for (const field of PLAIN_FIELDS) {
    const value = getNestedField(data, field);
    if (value) cache.set(field, value);
  }
}

// ─── Internal: env var fallback ───────────────────────────────────────────────

/**
 * Maps our dot-notation secret keys to legacy environment variable names.
 * This supports fresh deployments where the admin hasn't set up the UI yet.
 */
function getFromEnvVar(key: string): string | undefined {
  const envMap: Record<string, string[]> = {
    "ai.provider":          ["AI_PROVIDER"],
    "ai.apiKey":            ["AI_API_KEY"],
    "slack.botToken":       ["SLACK_BOT_TOKEN"],
    "slack.signingSecret":  ["SLACK_SIGNING_SECRET"],
    "slack.clientId":       ["SLACK_CLIENT_ID"],
    "slack.clientSecret":   ["SLACK_CLIENT_SECRET"],
    "asana.clientId":       ["ASANA_CLIENT_ID"],
    "asana.clientSecret":   ["ASANA_CLIENT_SECRET"],
  };

  const names = envMap[key];
  if (!names) return undefined;

  for (const name of names) {
    const val = process.env[name];
    if (val) return val;
  }
  return undefined;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Returns the value for the given secret key.
 *
 * @param key - Dot-notation key, e.g. "ai.apiKey", "slack.botToken"
 * @throws Error if the secret is not found anywhere in the resolution chain
 */
export async function getSecret(key: string): Promise<string> {
  // Reload from Firestore if this is the first call or the TTL has expired.
  // The TTL is the mechanism that propagates credential changes to instances
  // other than the one that handled the PUT /admin/secrets request.
  const cacheStale = !cacheLoaded || (Date.now() - cacheLoadedAt) > CACHE_TTL_MS;
  if (cacheStale) {
    cache.clear();
    await loadSecretsFromFirestore();
    cacheLoaded = true;
    cacheLoadedAt = Date.now();
  }

  // 1. Memory cache (populated by loadSecretsFromFirestore above)
  if (cache.has(key)) return cache.get(key)!;

  // 2. Env var fallback
  const envValue = getFromEnvVar(key);
  if (envValue) {
    cache.set(key, envValue);
    return envValue;
  }

  throw new Error(
    `Secret "${key}" not found. Configure it in Admin > Settings or set the corresponding environment variable.`
  );
}

/**
 * Saves (or updates) secrets in Firestore, encrypting sensitive fields with KMS.
 * Invalidates the in-memory cache so the next call re-reads from Firestore.
 *
 * @param updates  - Partial secrets object (only provided fields are written)
 * @param adminUid - UID of the admin saving the credentials (for audit)
 */
export async function setSecrets(
  updates: SecretsDoc,
  adminUid: string
): Promise<void> {
  const encrypted: Record<string, unknown> = {};

  for (const [section, fields] of Object.entries(updates)) {
    if (section === "configuredAt" || section === "configuredBy") continue;
    if (typeof fields !== "object" || fields === null) continue;

    encrypted[section] = {};
    for (const [key, value] of Object.entries(fields as Record<string, string>)) {
      if (typeof value !== "string" || value === "") continue;
      const fullKey = `${section}.${key}`;
      if (ENCRYPTED_FIELDS.includes(fullKey)) {
        (encrypted[section] as Record<string, string>)[key] = await encrypt(value);
      } else {
        (encrypted[section] as Record<string, string>)[key] = value;
      }
    }
  }

  await admin.firestore().doc("config/secrets").set(
    {
      ...encrypted,
      configuredAt: admin.firestore.FieldValue.serverTimestamp(),
      configuredBy: adminUid,
    },
    { merge: true }
  );

  // Invalidate cache on the local instance. Other instances will reload
  // automatically once their CACHE_TTL_MS window expires.
  cache.clear();
  cacheLoaded = false;
  cacheLoadedAt = 0;
}

/**
 * Returns a masked view of the stored secrets for the admin UI.
 * Encrypted fields show "••••••••" when configured, null when absent.
 * Plain fields show the actual value.
 * Actual secret values are NEVER returned.
 */
export async function getMaskedSecrets(): Promise<Record<string, unknown>> {
  const doc = await admin.firestore().doc("config/secrets").get();
  if (!doc.exists) return { configured: false };

  const data = doc.data() as Record<string, unknown>;
  const masked: Record<string, unknown> = { configured: true };

  for (const field of ENCRYPTED_FIELDS) {
    const value = getNestedField(data, field);
    setNestedField(masked, field, value ? "••••••••" : null);
  }
  for (const field of PLAIN_FIELDS) {
    setNestedField(masked, field, getNestedField(data, field) ?? null);
  }

  masked.configuredAt = data.configuredAt ?? null;
  masked.configuredBy = data.configuredBy ?? null;

  return masked;
}

/**
 * Returns whether a given integration has its secrets configured
 * (either in Firestore or as env vars). Used by GET /settings to show/hide
 * integration connection buttons.
 */
export async function isIntegrationConfigured(
  integration: "slack" | "asana" | "ai"
): Promise<boolean> {
  const keyMap: Record<string, string> = {
    slack: "slack.botToken",
    asana: "asana.clientId",
    ai: "ai.apiKey",
  };
  try {
    await getSecret(keyMap[integration]);
    return true;
  } catch {
    return false;
  }
}
