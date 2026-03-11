# TaskBot

AI-powered meeting task extraction and routing. Monitors Google Drive for meeting transcripts, extracts action items with Claude/GPT, and routes tasks to Asana or Google Tasks with Slack/email notifications.

Built on Firebase (Cloud Functions + Firestore + Hosting), TypeScript, and vanilla JS.

---

## Project Structure

```
Taskbot/
├── deploy/                     # Multi-client deployment tooling
│   ├── configs/
│   │   ├── .gitignore          # Gitignores all configs except template
│   │   ├── template.json       # Config template (copy per client)
│   │   └── internal.json       # Your own project (gitignored)
│   ├── setup-new-client.sh     # Bootstrap a new Firebase project
│   ├── deploy.sh               # Deploy updates to one client
│   └── deploy-all.sh           # Deploy updates to all clients
│
├── functions/                  # Cloud Functions (TypeScript, Node 22)
│   └── src/
│       ├── functions/          # Exported Cloud Functions
│       ├── services/           # Business logic (AI, Drive, Firestore, etc.)
│       ├── models/             # Shared TypeScript interfaces
│       └── index.ts            # Function entry point
│
├── web/                        # Frontend (Vanilla HTML/CSS/JS)
│   ├── index.html              # Sign-in page
│   ├── dashboard.html          # Task approval dashboard
│   ├── review.html             # Proposal review
│   ├── settings.html           # Per-user settings (Google Tasks, Asana)
│   ├── tasks.html              # Task list
│   ├── admin.html              # Admin panel (credentials, users, meetings)
│   └── styles.css
│
├── docs/                       # Documentation
├── firebase.json               # Firebase config (Functions, Hosting, Firestore)
├── firestore.rules             # Security rules
├── firestore.indexes.json      # Composite indexes
├── .env.example                # Environment variable reference
└── .gitignore
```

---

## Setting Up a New Client

### Prerequisites

- [Node.js 22+](https://nodejs.org/)
- [Firebase CLI](https://firebase.google.com/docs/cli): `npm install -g firebase-tools`
- [Google Cloud SDK](https://cloud.google.com/sdk/docs/install): `gcloud`
- [`jq`](https://stedolan.github.io/jq/): `brew install jq`
- A Firebase project created at [console.firebase.google.com](https://console.firebase.google.com/)
- Google OAuth 2.0 credentials (Client ID + Secret) from Google Cloud Console

### 1. Run the setup script

```bash
./deploy/setup-new-client.sh <client-name>
# Example:
./deploy/setup-new-client.sh thg
```

The script will prompt for the Firebase project ID, region, admin email, and Google OAuth credentials, then:

1. Save a config to `deploy/configs/<client-name>.json`
2. Enable required Google Cloud APIs
3. Create a KMS key ring and crypto key
4. Deploy Firestore indexes and security rules
5. Set environment variables
6. Build and deploy Cloud Functions
7. Deploy the web frontend

### 2. Sign in as the first user

Open the app URL printed at the end of the script. Sign in with the admin Google account. The first user to sign in is automatically promoted to admin.

### 3. Configure credentials via Admin Panel

1. Navigate to `/admin` → **Settings** tab
2. Enter your AI API key (Anthropic or OpenAI)
3. Optionally configure Slack (bot token, signing secret) and Asana (client ID/secret)
4. Click **Save All Credentials**

### 4. Each user connects their own integrations

Users visit `/settings` to connect Google Tasks and/or Asana via OAuth. TaskBot uses their own credentials for all task operations.

---

## Deploying Updates

### Update one client

```bash
./deploy/deploy.sh <client-name>
./deploy/deploy.sh <client-name> --only functions
./deploy/deploy.sh <client-name> --only hosting
./deploy/deploy.sh <client-name> --only firestore
```

### Update all clients

```bash
./deploy/deploy-all.sh
./deploy/deploy-all.sh --only functions
```

If one client fails, the script continues to the others and lists failures at the end.

---

## Rolling Back

### Hosting rollback

Firebase Hosting keeps a history of deployments. Roll back to the previous version:

```bash
firebase hosting:rollback --project=<projectId>
```

Or to a specific version, use the Firebase Console → Hosting → Release history → Roll back.

### Functions rollback

Cloud Functions are versioned in GCP but not directly "rolled back" via CLI. To revert:

1. Check out the previous git commit: `git checkout <sha> -- functions/src`
2. Redeploy: `./deploy/deploy.sh <client-name> --only functions`

For critical rollbacks with traffic urgency, use Cloud Console → Cloud Functions → select function → **Edit** and redeploy from the previous source.

---

## Environment Variables vs Firestore

| What | Where | How to set |
|---|---|---|
| Google OAuth Client ID/Secret | Firebase env vars (`functions:config`) | Set by `setup-new-client.sh` / `deploy.sh` |
| KMS key name | Firebase env vars | Set by `setup-new-client.sh` |
| App URL | Firebase env vars | Set by `setup-new-client.sh` |
| Anthropic / OpenAI API key | Firestore `config/secrets` (KMS-encrypted) | Admin Panel → Settings |
| Slack bot token, signing secret | Firestore `config/secrets` (KMS-encrypted) | Admin Panel → Settings |
| Asana OAuth credentials | Firestore `config/secrets` (KMS-encrypted) | Admin Panel → Settings |
| Org defaults (expiry, auto-approve) | Firestore `config/orgDefaults` | Admin Panel → Settings |
| Per-user Google OAuth tokens | Firestore `users/{uid}/tokens/google` (KMS-encrypted) | User OAuth flow |
| Per-user Asana tokens | Firestore `users/{uid}/tokens/asana` (KMS-encrypted) | User OAuth flow |

See [`.env.example`](.env.example) for full documentation of all environment variables.

> **Client configs are gitignored.** `deploy/configs/*.json` (except `template.json`) are excluded from git because they contain project IDs and OAuth secrets. Store them securely in a password manager or encrypted vault (e.g., 1Password, Bitwarden, or an encrypted S3 bucket).

---

## Local Development

### Install dependencies

```bash
npm install                        # Root dev tools
npm --prefix functions install     # Cloud Functions dependencies
```

### Configure local emulator

Create `functions/.runtimeconfig.json` (gitignored):

```json
{
  "google": {
    "client_id": "YOUR_CLIENT_ID",
    "client_secret": "YOUR_CLIENT_SECRET"
  },
  "kms": {
    "key_name": "projects/YOUR_PROJECT/locations/us-central1/keyRings/taskbot-keyring/cryptoKeys/taskbot-key"
  },
  "app": {
    "url": "http://localhost:3000"
  }
}
```

### Start emulators

```bash
npm run serve
```

| Service | URL |
|---|---|
| Hosting (web app) | http://localhost:3000 |
| Functions | http://localhost:5001 |
| Firestore | http://localhost:8080 |
| Emulator UI | http://localhost:4000 |

---

## Common Commands

| Command | Description |
|---|---|
| `npm run build` | Compile TypeScript → `functions/lib/` |
| `npm run build:watch` | Watch mode for TypeScript |
| `npm run serve` | Start all local emulators |
| `npm run lint` | Lint Cloud Functions code |
| `./deploy/setup-new-client.sh <name>` | Bootstrap a new client |
| `./deploy/deploy.sh <name>` | Deploy updates to one client |
| `./deploy/deploy-all.sh` | Deploy updates to all clients |

---

## Docs

- [`docs/architecture.md`](docs/architecture.md) — Data model, trigger reference, architecture decisions
- [`docs/SLACK_SETUP.md`](docs/SLACK_SETUP.md) — Slack app configuration guide
- [`.env.example`](.env.example) — Environment variable reference
