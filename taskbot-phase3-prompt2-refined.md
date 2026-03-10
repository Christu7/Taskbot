# Phase 3 — Prompt 2 (Refined) — Secrets Management

Copy the entire block below into Claude Code.

---

```
Move API credentials from environment variables into Firestore,
encrypted with Google Cloud KMS. This allows admins to configure
credentials from the admin UI instead of needing CLI access.

I'm giving you a detailed architecture. Follow it exactly.

═══════════════════════════════════════════════════════════════════
PART 1 — KMS SETUP AND ENCRYPTION SERVICE
═══════════════════════════════════════════════════════════════════

Create /functions/src/services/kms.ts

This is a LOW-LEVEL service. It only does two things: encrypt and
decrypt. Nothing else.

Install the KMS package:
  npm install @google-cloud/kms

The KMS key is identified by a resource name. Store it in ONE
environment variable:
  KMS_KEY_NAME=projects/[PROJECT_ID]/locations/global/keyRings/taskbot/cryptoKeys/secrets

Implementation:

  import { KeyManagementServiceClient } from '@google-cloud/kms';

  const kmsClient = new KeyManagementServiceClient();

  // Read once at module load — this is the ONLY env var for secrets
  const keyName = process.env.KMS_KEY_NAME;

  export async function encrypt(plaintext: string): Promise<string> {
    if (!keyName) throw new Error('KMS_KEY_NAME not configured');
    const [result] = await kmsClient.encrypt({
      name: keyName,
      plaintext: Buffer.from(plaintext),
    });
    // Return as base64 string for Firestore storage
    return Buffer.from(result.ciphertext as Uint8Array).toString('base64');
  }

  export async function decrypt(ciphertext: string): Promise<string> {
    if (!keyName) throw new Error('KMS_KEY_NAME not configured');
    const [result] = await kmsClient.decrypt({
      name: keyName,
      ciphertext: Buffer.from(ciphertext, 'base64'),
    });
    return Buffer.from(result.plaintext as Uint8Array).toString('utf8');
  }

IMPORTANT: Cloud Functions running on the same GCP project as the KMS
key automatically have permission to use it — no extra IAM config needed.
If the Firebase project and KMS key are in different projects, IAM
permissions are needed (document this but don't implement it).

Add a comment at the top of kms.ts with the exact gcloud commands to
create the key ring and key:

  # Run these once per Firebase project:
  gcloud kms keyrings create taskbot --location=global --project=[PROJECT_ID]
  gcloud kms keys create secrets --location=global --keyring=taskbot \
    --purpose=encryption --project=[PROJECT_ID]

  # Then set the env var:
  npx firebase functions:config:set kms.key_name="projects/[PROJECT_ID]/locations/global/keyRings/taskbot/cryptoKeys/secrets"

═══════════════════════════════════════════════════════════════════
PART 2 — SECRETS SERVICE (HIGH-LEVEL, WITH CACHING)
═══════════════════════════════════════════════════════════════════

Create /functions/src/services/secrets.ts

This is the service that ALL other code will call. It reads from
Firestore, decrypts with KMS, and caches in memory.

  DESIGN PRINCIPLES:
  - Callers never touch Firestore or KMS directly for secrets
  - Callers never know whether the secret came from Firestore or
    env vars (fallback is transparent)
  - Decrypted values are cached in a module-level Map for the
    lifetime of the Cloud Function instance (typically <5 minutes,
    safe for secrets)
  - The cache is NEVER exported or logged

  Implementation structure:

  // Module-level cache — lives for the Cloud Function cold start lifetime
  const cache = new Map<string, string>();
  let cacheLoaded = false;

  // The Firestore document structure at config/secrets:
  interface SecretsDoc {
    ai: {
      provider: string;         // NOT encrypted (just "anthropic" | "openai" | "gemini")
      apiKey: string;           // encrypted
    };
    slack: {
      botToken: string;         // encrypted
      signingSecret: string;    // encrypted
      clientId: string;         // NOT encrypted
      clientSecret: string;     // encrypted
    };
    asana: {
      clientId: string;         // NOT encrypted
      clientSecret: string;     // encrypted
    };
    configuredAt?: Timestamp;
    configuredBy?: string;
  }

  // Fields that are encrypted (used to know what to decrypt/encrypt)
  const ENCRYPTED_FIELDS = [
    'ai.apiKey',
    'slack.botToken',
    'slack.signingSecret',
    'slack.clientSecret',
    'asana.clientSecret',
  ];

  // Fields that are stored in plain text
  const PLAIN_FIELDS = [
    'ai.provider',
    'slack.clientId',
    'asana.clientId',
  ];

  export async function getSecret(key: string): Promise<string> {
    // 1. Check memory cache first
    if (cache.has(key)) return cache.get(key)!;

    // 2. Try loading all secrets from Firestore (load once, cache all)
    if (!cacheLoaded) {
      await loadSecretsFromFirestore();
      cacheLoaded = true;
    }

    // 3. Check cache again after Firestore load
    if (cache.has(key)) return cache.get(key)!;

    // 4. Fallback: check environment variables (for fresh deployments
    //    where admin hasn't configured the UI yet)
    const envValue = getFromEnvVar(key);
    if (envValue) {
      cache.set(key, envValue);
      return envValue;
    }

    throw new Error(`Secret not found: ${key}. Configure it in Admin > Settings.`);
  }

  async function loadSecretsFromFirestore(): Promise<void> {
    const doc = await admin.firestore().doc('config/secrets').get();
    if (!doc.exists) return; // No secrets in Firestore yet, will fall back to env vars

    const data = doc.data() as SecretsDoc;

    // Decrypt encrypted fields
    for (const field of ENCRYPTED_FIELDS) {
      const value = getNestedField(data, field);
      if (value) {
        try {
          const decrypted = await decrypt(value);
          cache.set(field, decrypted);
        } catch (err) {
          logger.error(`Failed to decrypt ${field}`, err);
          // Don't cache — will fall back to env var
        }
      }
    }

    // Plain fields go straight to cache
    for (const field of PLAIN_FIELDS) {
      const value = getNestedField(data, field);
      if (value) cache.set(field, value);
    }
  }

  // Map our secret keys to legacy environment variable names
  // This is the fallback for fresh deployments
  function getFromEnvVar(key: string): string | undefined {
    const envMap: Record<string, string> = {
      'ai.provider':       'AI_PROVIDER',      // or however it's currently named
      'ai.apiKey':         'AI_API_KEY',        // or ANTHROPIC_API_KEY, etc.
      'slack.botToken':    'SLACK_BOT_TOKEN',
      'slack.signingSecret': 'SLACK_SIGNING_SECRET',
      'slack.clientId':    'SLACK_CLIENT_ID',
      'slack.clientSecret': 'SLACK_CLIENT_SECRET',
      'asana.clientId':    'ASANA_CLIENT_ID',
      'asana.clientSecret': 'ASANA_CLIENT_SECRET',
    };
    const envName = envMap[key];
    if (!envName) return undefined;

    // Check both process.env and Firebase functions.config()
    return process.env[envName]
      || functions.config()?.taskbot?.[envName.toLowerCase()]
      || undefined;
  }

  // Helper to save secrets from the admin UI
  export async function setSecrets(
    updates: Partial<SecretsDoc>,
    adminUid: string
  ): Promise<void> {
    // Encrypt the fields that need encryption
    const encrypted: any = {};

    for (const [section, fields] of Object.entries(updates)) {
      encrypted[section] = {};
      for (const [key, value] of Object.entries(fields as Record<string, string>)) {
        const fullKey = `${section}.${key}`;
        if (ENCRYPTED_FIELDS.includes(fullKey) && value) {
          encrypted[section][key] = await encrypt(value);
        } else if (value !== undefined) {
          encrypted[section][key] = value;
        }
      }
    }

    await admin.firestore().doc('config/secrets').set({
      ...encrypted,
      configuredAt: admin.firestore.FieldValue.serverTimestamp(),
      configuredBy: adminUid,
    }, { merge: true });

    // Invalidate cache so next call re-reads from Firestore
    cache.clear();
    cacheLoaded = false;
  }

  // For the admin UI: return masked values
  export async function getMaskedSecrets(): Promise<any> {
    const doc = await admin.firestore().doc('config/secrets').get();
    if (!doc.exists) return { configured: false };

    const data = doc.data()!;
    const masked: any = { configured: true };

    // For encrypted fields, show "configured" but not the value
    // For plain fields, show the actual value
    for (const field of ENCRYPTED_FIELDS) {
      const value = getNestedField(data, field);
      setNestedField(masked, field, value ? '••••••••' : null);
    }
    for (const field of PLAIN_FIELDS) {
      setNestedField(masked, field, getNestedField(data, field) || null);
    }

    masked.configuredAt = data.configuredAt;
    masked.configuredBy = data.configuredBy;

    return masked;
  }

  Implement getNestedField and setNestedField as simple dot-notation
  helpers (e.g., getNestedField({ai: {apiKey: "x"}}, "ai.apiKey") → "x")

═══════════════════════════════════════════════════════════════════
PART 3 — MIGRATE ALL EXISTING CALLSITES
═══════════════════════════════════════════════════════════════════

This is the critical part. Every file that currently reads credentials
from environment variables or Firebase config must switch to using
getSecret(). Here is the COMPLETE list of callsites to update:

FILE 1: /functions/src/services/aiProvider.ts (or the Anthropic implementation)
  CURRENTLY READS: AI API key from env var (AI_API_KEY or similar)
  CHANGE TO: const apiKey = await getSecret('ai.apiKey');
             const provider = await getSecret('ai.provider');
  LOCATION IN CODE: wherever the Anthropic/OpenAI client is initialized
  NOTE: The AI client may be initialized at module level — move it to
  lazy initialization inside the function call since getSecret is async.
  Pattern:
    let client: AnthropicClient | null = null;
    async function getClient() {
      if (!client) {
        const apiKey = await getSecret('ai.apiKey');
        client = new Anthropic({ apiKey });
      }
      return client;
    }

FILE 2: /functions/src/services/slack/slackNotifier.ts
  CURRENTLY READS: SLACK_BOT_TOKEN from env
  CHANGE TO: const botToken = await getSecret('slack.botToken');
  NOTE: Same lazy initialization pattern. The Slack Web API client
  needs the token at construction time.

FILE 3: /functions/src/services/slack/slackAuth.ts
  CURRENTLY READS: SLACK_CLIENT_ID, SLACK_CLIENT_SECRET from env
  CHANGE TO: const clientId = await getSecret('slack.clientId');
             const clientSecret = await getSecret('slack.clientSecret');
  USED IN: OAuth URL generation and token exchange

FILE 4: /functions/src/functions/slackInteraction.ts
  CURRENTLY READS: SLACK_SIGNING_SECRET from env
  CHANGE TO: const signingSecret = await getSecret('slack.signingSecret');
  USED IN: Request verification (the crypto.timingSafeEqual check)
  CRITICAL: This is called on every Slack button click. The secret
  must be available fast. The cache handles this — first call decrypts,
  subsequent calls in the same function instance hit the cache.

FILE 5: /functions/src/services/asana/asanaAuth.ts
  CURRENTLY READS: ASANA_CLIENT_ID, ASANA_CLIENT_SECRET from env
  CHANGE TO: const clientId = await getSecret('asana.clientId');
             const clientSecret = await getSecret('asana.clientSecret');
  USED IN: OAuth URL generation and token exchange

FILE 6: /functions/src/services/asana/asanaApi.ts
  CHECK: Does this file read any secrets directly, or does it only
  use user-level OAuth tokens? If it only uses user tokens passed
  in as arguments, no changes needed here. If it reads app-level
  credentials for anything, update those callsites.

FILES THAT DO NOT NEED CHANGES:
  - Google OAuth (drive.ts, calendar.ts, googleTasks.ts, googleTasksDestination.ts)
    These use PER-USER OAuth tokens from Firestore, not app-level secrets.
    The Google OAuth CLIENT_ID and CLIENT_SECRET stay in env vars
    (needed before any user can sign in).
  - emailSender.ts — uses user's Gmail API tokens, not app credentials
  - firestore.ts — no secrets
  - kms.ts — reads KMS_KEY_NAME from env var (this is intentional)

IMPORTANT PATTERN: Every file that currently initializes a client at
module level (top of file) using an env var must change to lazy init:

  // BEFORE (breaks because env var is gone):
  const client = new Anthropic({ apiKey: process.env.AI_API_KEY });

  // AFTER (works with Firestore secrets):
  let client: Anthropic | null = null;
  async function getClient(): Promise<Anthropic> {
    if (!client) {
      client = new Anthropic({ apiKey: await getSecret('ai.apiKey') });
    }
    return client;
  }

Do NOT use a singleton pattern that persists across function invocations
for security. Use module-level variable that reinitializes if the
function cold-starts. This is the default Cloud Functions behavior —
module-level variables persist during warm instances but reset on
cold start. This is acceptable because:
  - Warm instances last ~5-15 minutes
  - If an admin changes a secret, new function instances pick it up
    within minutes as old instances are recycled
  - For immediate effect after changing secrets, admin can redeploy
    functions (document this in the UI)

═══════════════════════════════════════════════════════════════════
PART 4 — ADMIN API ENDPOINTS
═══════════════════════════════════════════════════════════════════

Add these to /functions/src/functions/adminApi.ts (created in Prompt 1):

  GET /api/admin/secrets
    - Requires admin (use requireAdmin middleware from Prompt 1)
    - Calls getMaskedSecrets() from the secrets service
    - Returns: { configured: boolean, ai: { provider, apiKey: "••••" }, ... }
    - NEVER returns actual secret values. Only masked indicators.

  PUT /api/admin/secrets
    - Requires admin
    - Body: partial update, e.g.:
      { ai: { provider: "anthropic", apiKey: "sk-ant-..." } }
    - Only updates the fields that are provided in the body
    - Calls setSecrets(body, uid)
    - Returns: { success: true, configuredAt: timestamp }
    - Validate: if ai.provider is set, it must be one of
      "anthropic" | "openai" | "gemini"
    - Validate: apiKey must not be empty string

  POST /api/admin/secrets/test
    - Requires admin
    - Tests each configured credential:

    AI test:
      - Read provider and apiKey from secrets
      - If provider is "anthropic": call the messages API with
        model: "claude-sonnet-4-20250514", max_tokens: 10,
        messages: [{ role: "user", content: "Say 'ok'" }]
      - If provider is "openai": call chat.completions.create with
        model: "gpt-4o", max_tokens: 10
      - Catch errors, return status

    Slack test:
      - Read botToken from secrets
      - Call Slack's auth.test endpoint with the token
      - Returns the bot name and team if successful

    Asana test:
      - Read clientId and clientSecret from secrets
      - Note: we can't fully test Asana OAuth credentials without
        a user going through the flow. Instead, verify the credentials
        exist and are non-empty. Return "configured" rather than "ok".
      - If we have any user with asanaTokens in Firestore, try a
        GET /users/me call with their tokens to verify Asana API
        is reachable.

    Return: {
      ai: { status: "ok" | "error" | "not_configured", message?: string },
      slack: { status: "ok" | "error" | "not_configured", message?: string, team?: string },
      asana: { status: "configured" | "error" | "not_configured", message?: string }
    }

    Timeout: 30 seconds for this endpoint (API calls may be slow)

═══════════════════════════════════════════════════════════════════
PART 5 — HANDLE UNCONFIGURED STATE GRACEFULLY
═══════════════════════════════════════════════════════════════════

The system must work even when secrets aren't configured yet (fresh
deployment, admin hasn't set up credentials).

For each service, handle the "not configured" case:

1. aiProvider.ts / aiExtractor.ts:
   - If getSecret('ai.apiKey') throws "Secret not found":
     * Don't crash the function
     * Set processedTranscript status to "awaiting_configuration"
     * Set error field to: "AI provider not configured. An admin
       needs to set up AI credentials in Admin > Settings."
     * The transcript stays in this state until credentials are
       configured, then can be reprocessed

2. slackNotifier.ts:
   - If getSecret('slack.botToken') throws:
     * Log a warning
     * Skip Slack notification silently
     * If user's ONLY notification channel is Slack, fall back to
       email and log: "Slack not configured, falling back to email
       for user {uid}"

3. slackAuth.ts (OAuth flow):
   - If getSecret('slack.clientId') throws:
     * Return a user-friendly error page: "Slack integration is not
       configured for this organization. Contact your admin."
     * Don't show the "Connect Slack" button in user settings if
       Slack isn't configured (check via a new endpoint or include
       configuration status in the user settings API response)

4. asanaAuth.ts (OAuth flow):
   - Same pattern as Slack: if not configured, show friendly error
     and hide the "Connect Asana" button

5. Add to the existing GET /api/settings response:
   - availableIntegrations: {
       slack: boolean,   // true if slack secrets exist in Firestore
       asana: boolean,   // true if asana secrets exist in Firestore
     }
   - The frontend uses this to show/hide connection buttons

═══════════════════════════════════════════════════════════════════
PART 6 — FIRESTORE SECURITY RULES
═══════════════════════════════════════════════════════════════════

Update firestore.rules:

  match /config/secrets {
    // ONLY admins can read or write secrets
    allow read, write: if request.auth != null
      && get(/databases/$(database)/documents/users/$(request.auth.uid)).data.role == "admin";
  }

  // The admin API endpoints are the primary security boundary,
  // but Firestore rules are the backup in case of bugs in the API.
  // Belt AND suspenders.

═══════════════════════════════════════════════════════════════════
PART 7 — SECURITY CHECKLIST
═══════════════════════════════════════════════════════════════════

After building everything, verify:

  [ ] GET /api/admin/secrets NEVER returns actual secret values
      (only "••••••••" or null)
  [ ] Decrypted secrets are NEVER in logger output — search all
      files for logger.info, logger.warn, logger.error and verify
      no secret variables are interpolated into log messages
  [ ] The memory cache (Map) is not exported from secrets.ts
  [ ] PUT /api/admin/secrets requires admin role
  [ ] The Firestore rule on config/secrets requires admin role
  [ ] Error messages from getSecret() don't include the key name
      in user-facing responses (only in server logs)
  [ ] The KMS_KEY_NAME env var is the ONLY secret in env vars
      (plus Google OAuth client ID/secret which must stay there)

═══════════════════════════════════════════════════════════════════
ORDER OF IMPLEMENTATION
═══════════════════════════════════════════════════════════════════

Build in this exact order:

  1. kms.ts — the encryption/decryption primitives (Part 1)
  2. secrets.ts — the high-level service with caching (Part 2)
  3. Firestore security rules for config/secrets (Part 6)
  4. Migrate all callsites to use getSecret() (Part 3)
     — DO THIS FILE BY FILE, test the build compiles after each file
  5. Admin API endpoints (Part 4)
  6. Unconfigured state handling (Part 5)
  7. Security checklist (Part 7)

After building, confirm:
  - The project compiles with no errors
  - List every file you changed in Part 3
  - Confirm whether asanaApi.ts needed changes or not
  - Confirm the exact env var names you found in the current code
    (they may differ from what I listed — tell me the actual names)
```

---

## What this refined prompt does differently

**For your reference — don't include this section in the Claude Code prompt.**

1. **Complete KMS implementation provided** — Instead of saying "use KMS," the prompt gives the actual code for encrypt/decrypt. Sonnet doesn't need to figure out the KMS API; it just needs to implement it. The gcloud CLI commands are included so you know exactly what to run.

2. **Every callsite enumerated by filename** — Six files listed, with what they currently read, what they should change to, and where in the code the change happens. Files that DON'T need changes are explicitly listed to prevent Sonnet from changing them unnecessarily.

3. **The lazy initialization pattern is spelled out** — This is the trickiest part of the migration. Module-level client initialization breaks when you switch from sync env vars to async Firestore reads. The prompt shows the exact before/after pattern and explains why it's safe for Cloud Functions.

4. **Cache invalidation strategy is explicit** — The prompt specifies that `cache.clear()` happens on setSecrets, and that admin can redeploy for immediate effect. Without this, Sonnet might build an overly complex cache invalidation system or miss it entirely.

5. **Env var fallback is a first-class feature** — Fresh deployments need to work before any admin configures the UI. The fallback chain (cache → Firestore → env var) is spelled out so the system boots cleanly in any state.

6. **The masked secrets pattern prevents leaks** — The prompt explicitly requires that GET /api/admin/secrets returns "••••••••" not actual values. Without this, Sonnet might return decrypted secrets to the frontend "for convenience."

7. **Security checklist at the end** — Forces Sonnet to verify its own work against specific security criteria before considering the task done.
