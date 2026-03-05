#!/usr/bin/env bash
# TaskBot deployment script
# Usage:
#   ./scripts/deploy.sh                   # full deploy (functions + rules + hosting)
#   ./scripts/deploy.sh --only functions  # functions only
#   ./scripts/deploy.sh --only hosting    # hosting only
#   ./scripts/deploy.sh --only firestore  # Firestore rules + indexes only

set -euo pipefail

cd "$(dirname "$0")/.."

# ─── Parse --only flag ────────────────────────────────────────────────────────
ONLY=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      ONLY="$2"
      shift 2
      ;;
    --only=*)
      ONLY="${1#--only=}"
      shift
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

# ─── Build functions ──────────────────────────────────────────────────────────
# Always build unless we're deploying hosting-only or firestore-only
if [[ -z "$ONLY" || "$ONLY" == *"functions"* ]]; then
  echo "Building Cloud Functions..."
  npm --prefix functions run build
  echo "Build complete."
fi

# ─── Deploy ───────────────────────────────────────────────────────────────────
echo ""
if [[ -n "$ONLY" ]]; then
  echo "Deploying: $ONLY"
  npx firebase deploy --only "$ONLY"
else
  echo "Deploying: functions, firestore, hosting"
  npx firebase deploy
fi

echo ""
echo "Deploy complete."
