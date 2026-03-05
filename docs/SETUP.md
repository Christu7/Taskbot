# TaskBot — Setup Guide

Complete instructions for deploying TaskBot from scratch.

---

## Prerequisites

- Node.js 20+ and npm
- Firebase CLI: `npm install -g firebase-tools`
- A Google account with billing enabled (required for Cloud Functions)
- A Google Cloud project (can reuse an existing Firebase project)

---

## 1. Firebase Project

### 1.1 Create the project

1. Go to https://console.firebase.google.com
2. **Add project** → give it a name (e.g. `taskbot`)
3. Enable Google Analytics if desired → **Create project**

### 1.2 Enable Firestore

1. In the Firebase Console → **Firestore Database** → **Create database**
2. Choose **Production mode** (rules are deployed from `firestore.rules`)
3. Select a region (recommend `us-central1` to match Cloud Functions)

### 1.3 Enable Firebase Auth

1. **Authentication** → **Get started**
2. **Sign-in method** → enable **Google**
3. Add your project's hosting domain to **Authorized domains**

### 1.4 Enable Firebase Hosting

1. **Hosting** → **Get started** → follow the prompts
2. The public directory is `web/`

### 1.5 Update `.firebaserc`

```json
{
  "projects": {
    "default": "YOUR_FIREBASE_PROJECT_ID"
  }
}
```

---

## 2. Google Cloud Console — OAuth Setup

### 2.1 Enable required APIs

In https://console.cloud.google.com/apis/library (select your project):

- Google Drive API
- Google Calendar API
- Gmail API
- Google Tasks API

### 2.2 Create OAuth credentials

1. **APIs & Services** → **Credentials** → **Create Credentials** → **OAuth client ID**
2. Application type: **Web application**
3. Name: `TaskBot`
4. **Authorized redirect URIs** — add both:
   - Production: `https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/oauthCallback`
   - Local dev: `http://localhost:5001/YOUR_PROJECT_ID/us-central1/oauthCallback`
5. Save — copy the **Client ID** and **Client Secret**

### 2.3 Configure OAuth consent screen

1. **OAuth consent screen** → **External** (or Internal for workspace)
2. Fill in app name, support email
3. **Scopes** → Add all required scopes:
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/calendar.readonly`
   - `https://www.googleapis.com/auth/gmail.send`
   - `https://www.googleapis.com/auth/tasks`
4. Add test users if using External type in development

---

## 3. Firebase Web App Config

### 3.1 Register a web app

1. Firebase Console → **Project settings** → **Your apps** → **Add app** → **Web**
2. Copy the `firebaseConfig` object

### 3.2 Update `web/js/firebase-config.js`

Replace the `firebaseConfig` object with your project's values.

---

## 4. Environment Variables

Create `functions/.env` from this template:

```bash
# ─── AI Provider ─────────────────────────────────────────────────────────────
# Which provider to use: "anthropic" or "openai"
AI_PROVIDER=anthropic

# ─── Anthropic (Claude) ───────────────────────────────────────────────────────
# Get your key at https://console.anthropic.com
# Models: claude-haiku-4-5-20251001 | claude-sonnet-4-6 | claude-opus-4-6
ANTHROPIC_MODEL=claude-sonnet-4-6
ANTHROPIC_API_KEY=sk-ant-...

# ─── OpenAI (optional) ────────────────────────────────────────────────────────
# Set AI_PROVIDER=openai and add your key to use GPT instead
# OPENAI_MODEL=gpt-4o-mini
# OPENAI_API_KEY=sk-...

# ─── Web App URL ──────────────────────────────────────────────────────────────
APP_URL=https://YOUR_PROJECT_ID.web.app

# ─── Google OAuth2 Credentials ───────────────────────────────────────────────
GOOGLE_CLIENT_ID=YOUR_CLIENT_ID.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-...

# ─── OAuth Redirect URI ───────────────────────────────────────────────────────
# Production — must exactly match what's registered in GCP Console
OAUTH_REDIRECT_URI=https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/oauthCallback

# ─── Post-OAuth Redirect ──────────────────────────────────────────────────────
OAUTH_SUCCESS_REDIRECT=https://YOUR_PROJECT_ID.web.app
```

### All environment variables

| Variable | Required | Description |
|---|---|---|
| `AI_PROVIDER` | No | `"anthropic"` (default) or `"openai"` |
| `ANTHROPIC_API_KEY` | Yes (if Anthropic) | Anthropic API key |
| `ANTHROPIC_MODEL` | No | Claude model name (default: `claude-sonnet-4-6`) |
| `OPENAI_API_KEY` | Yes (if OpenAI) | OpenAI API key |
| `OPENAI_MODEL` | No | GPT model name (default: `gpt-4o-mini`) |
| `APP_URL` | No | Frontend base URL (default: `https://taskbot-fb10d.web.app`) |
| `GOOGLE_CLIENT_ID` | Yes | OAuth client ID from GCP Console |
| `GOOGLE_CLIENT_SECRET` | Yes | OAuth client secret from GCP Console |
| `OAUTH_REDIRECT_URI` | Yes | Must match registered redirect URI exactly |
| `OAUTH_SUCCESS_REDIRECT` | Yes | Where to redirect after OAuth completes |

---

## 5. First Deployment

### 5.1 Install dependencies

```bash
# Root
npm install

# Functions
npm --prefix functions install
```

### 5.2 Log in to Firebase

```bash
firebase login
```

### 5.3 Deploy everything

```bash
# Using the deploy script
./scripts/deploy.sh

# Or directly
npx firebase deploy
```

This deploys:
- Cloud Functions (12 functions)
- Firestore security rules
- Firestore indexes
- Hosting (web app)

### 5.4 Verify deployment

```bash
curl https://us-central1-YOUR_PROJECT_ID.cloudfunctions.net/healthCheck
```

All services should report `"ok"`.

---

## 6. Local Development

### 6.1 Start the emulators

```bash
npm run serve
```

This starts:
- Functions emulator: http://localhost:5001
- Firestore emulator: http://localhost:8080
- Hosting emulator: http://localhost:3000
- Emulator UI: http://localhost:4000

### 6.2 Local OAuth redirect

Update `functions/.env` for local development:

```bash
OAUTH_REDIRECT_URI=http://localhost:5001/YOUR_PROJECT_ID/us-central1/oauthCallback
OAUTH_SUCCESS_REDIRECT=http://localhost:3000
```

> Note: Google OAuth requires HTTPS for production redirect URIs. For local development, `localhost` is allowed.

---

## 7. Subsequent Deployments

```bash
# Deploy everything
./scripts/deploy.sh

# Deploy only functions
./scripts/deploy.sh --only functions

# Deploy only the web app
./scripts/deploy.sh --only hosting

# Deploy only Firestore rules
./scripts/deploy.sh --only firestore
```
