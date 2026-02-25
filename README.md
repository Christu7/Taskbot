# TaskBot

Serverless task management bot built with Firebase (Cloud Functions + Firestore + Hosting) and TypeScript.

---

## Project Structure

```
Taskbot/
├── functions/              # Cloud Functions (TypeScript, Node 20)
│   ├── src/
│   │   └── index.ts        # Function entry point
│   ├── package.json
│   └── tsconfig.json
│
├── web/                    # Frontend (Vanilla HTML/CSS/JS)
│   ├── index.html          # Task approval dashboard
│   ├── styles.css
│   └── app.js              # Firestore real-time listener
│
├── docs/                   # Documentation
│   └── architecture.md     # Stack, data model, triggers
│
├── firebase.json           # Firebase config (Functions, Hosting, Emulators)
├── .firebaserc             # Firebase project alias
├── package.json            # Root scripts (deploy, serve, build)
└── .gitignore
```

---

## Prerequisites

- [Node.js 20+](https://nodejs.org/)
- [npx](https://www.npmjs.com/package/npx) (bundled with npm)
- A [Firebase project](https://console.firebase.google.com/) with Firestore enabled

---

## Getting Started

### 1. Set your Firebase project

Edit `.firebaserc` and replace `YOUR_FIREBASE_PROJECT_ID` with your actual project ID:

```json
{ "projects": { "default": "my-real-project-id" } }
```

Then log in and select the project:

```bash
npx firebase login
npx firebase use --add
```

### 2. Install dependencies

```bash
# Root dev tools (firebase-tools)
npm install

# Cloud Functions dependencies
npm run install:functions
```

### 3. Configure the frontend

In `web/app.js`, replace the `firebaseConfig` placeholder values with your actual Firebase SDK config.
Find it at: **Firebase Console → Project Settings → Your Apps → SDK setup & configuration**.

### 4. Start local emulators

```bash
npm run serve
```

| Service | URL |
|---|---|
| Hosting (web app) | http://localhost:5000 |
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
| `npm run deploy` | Deploy everything to Firebase |
| `npm run deploy:functions` | Deploy Cloud Functions only |
| `npm run deploy:hosting` | Deploy web frontend only |
| `npm run lint` | Lint Cloud Functions code |
| `npm run logs` | Stream live function logs |

---

## Docs

See [`docs/architecture.md`](docs/architecture.md) for data model, trigger reference, and architecture decisions.
