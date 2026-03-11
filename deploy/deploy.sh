#!/usr/bin/env bash
# deploy.sh — Deploy TaskBot updates to a specific client project.
# Usage: ./deploy.sh <client-name> [--only functions|hosting|rules|firestore]
# Examples:
#   ./deploy.sh thg
#   ./deploy.sh thg --only functions
#   ./deploy.sh internal --only hosting

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIGS_DIR="$SCRIPT_DIR/configs"

# ── Helpers ───────────────────────────────────────────────────────────────────

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
die()   { red "ERROR: $*"; exit 1; }

require_cmd() {
  command -v "$1" &>/dev/null || die "'$1' is required but not installed."
}

# ── Args ──────────────────────────────────────────────────────────────────────

require_cmd firebase
require_cmd jq

[[ $# -ge 1 ]] || die "Usage: $0 <client-name> [--only functions|hosting|rules|firestore]"

CLIENT="$1"
shift

ONLY_FLAG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      [[ $# -ge 2 ]] || die "--only requires a target (functions, hosting, rules, firestore)"
      ONLY_FLAG="--only $2"
      shift 2
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

CONFIG_FILE="$CONFIGS_DIR/${CLIENT}.json"
[[ -f "$CONFIG_FILE" ]] || die "Config not found: $CONFIG_FILE\nRun ./setup-new-client.sh $CLIENT first."

# ── Load config ───────────────────────────────────────────────────────────────

PROJECT_ID=$(jq -r '.projectId' "$CONFIG_FILE")
REGION=$(jq -r '.region' "$CONFIG_FILE")
GOOGLE_CLIENT_ID=$(jq -r '.google.oauthClientId' "$CONFIG_FILE")
GOOGLE_CLIENT_SECRET=$(jq -r '.google.oauthClientSecret' "$CONFIG_FILE")
KMS_KEY_NAME=$(jq -r '.kms.keyName' "$CONFIG_FILE")
APP_URL=$(jq -r '.appUrl' "$CONFIG_FILE")

[[ -n "$PROJECT_ID" ]] || die "projectId is empty in $CONFIG_FILE"

# ── Deploy ────────────────────────────────────────────────────────────────────

bold ""
bold "TaskBot — Deploy: $CLIENT"
if [[ -n "$ONLY_FLAG" ]]; then
  bold "  Target: ${ONLY_FLAG#--only }"
fi
bold "  Project: $PROJECT_ID"
bold "  URL: $APP_URL"
echo ""

cd "$REPO_ROOT"

# Switch project
firebase use "$PROJECT_ID" --non-interactive 2>/dev/null || \
  firebase use "$PROJECT_ID"

# Sync env vars in case config changed
firebase functions:config:set \
  google.client_id="$GOOGLE_CLIENT_ID" \
  google.client_secret="$GOOGLE_CLIENT_SECRET" \
  kms.key_name="$KMS_KEY_NAME" \
  app.url="$APP_URL" \
  --project="$PROJECT_ID"

# Build functions unless we're only deploying hosting
if [[ -z "$ONLY_FLAG" || "$ONLY_FLAG" == "--only functions" ]]; then
  printf "Building Cloud Functions... "
  npm --prefix "$REPO_ROOT/functions" run build
  green "done"
fi

# Deploy
printf "Deploying to %s... " "$PROJECT_ID"
# shellcheck disable=SC2086
firebase deploy $ONLY_FLAG --project="$PROJECT_ID"

echo ""
green "Deploy complete: $APP_URL"
echo ""
