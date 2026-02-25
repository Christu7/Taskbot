# TaskBot — Architecture Overview

## Stack

| Layer | Technology |
|---|---|
| Cloud Functions | Firebase Functions v4 (Node 20, TypeScript) |
| Database | Cloud Firestore |
| Frontend | Vanilla HTML/CSS/JS (Firebase Hosting) |
| Auth | Firebase Authentication (to be added) |
| CI/CD | GitHub Actions (to be added) |

## Data Model (Firestore)

```
tasks/{taskId}
  ├── title        : string
  ├── description  : string
  ├── status       : "pending" | "approved" | "rejected"
  ├── createdAt    : timestamp
  ├── createdBy    : string (uid)
  └── assignedTo   : string (uid) | null
```

## Function Triggers

| Function | Trigger | Purpose |
|---|---|---|
| `healthCheck` | HTTPS GET | Verifies functions are running |
| `onTaskCreated` | Firestore onCreate | Runs when a new task is added |

## Hosting Rewrites

- `/api/**` → `healthCheck` function
- Everything else → `web/index.html` (SPA catch-all, if needed)

## Local Development

```bash
# Start all emulators (Functions + Firestore + Hosting UI)
npm run serve

# Emulator ports:
#   Hosting  → http://localhost:5000
#   Functions → http://localhost:5001
#   Firestore → http://localhost:8080
#   UI        → http://localhost:4000
```
