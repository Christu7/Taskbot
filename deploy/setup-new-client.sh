#!/usr/bin/env bash
# setup-new-client.sh — Bootstrap a new TaskBot Firebase project for a client.
# Usage: ./setup-new-client.sh <client-name>
# Example: ./setup-new-client.sh thg

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CONFIGS_DIR="$SCRIPT_DIR/configs"

# ── Helpers ───────────────────────────────────────────────────────────────────

bold()  { printf "\033[1m%s\033[0m\n" "$*"; }
green() { printf "\033[32m%s\033[0m\n" "$*"; }
yellow(){ printf "\033[33m%s\033[0m\n" "$*"; }
red()   { printf "\033[31m%s\033[0m\n" "$*"; }
die()   { red "ERROR: $*"; exit 1; }

confirm() {
  local prompt="$1"
  local answer
  read -r -p "$prompt [y/N] " answer
  [[ "$answer" =~ ^[Yy]$ ]]
}

require_cmd() {
  command -v "$1" &>/dev/null || die "'$1' is required but not installed."
}

# ── Pre-flight ─────────────────────────────────────────────────────────────────

require_cmd firebase
require_cmd gcloud
require_cmd jq

[[ $# -ge 1 ]] || die "Usage: $0 <client-name>\nExample: $0 thg"

CLIENT="$1"
CONFIG_FILE="$CONFIGS_DIR/${CLIENT}.json"

[[ "$CLIENT" == "template" ]] && die "Cannot use 'template' as a client name."

bold ""
bold "TaskBot — New Client Setup: $CLIENT"
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── Create or load config ──────────────────────────────────────────────────────

if [[ -f "$CONFIG_FILE" ]]; then
  yellow "Config file already exists: $CONFIG_FILE"
  confirm "Load existing config and continue?" || die "Aborted."
  PROJECT_ID=$(jq -r '.projectId' "$CONFIG_FILE")
  REGION=$(jq -r '.region' "$CONFIG_FILE")
  ADMIN_EMAIL=$(jq -r '.adminEmail' "$CONFIG_FILE")
  GOOGLE_CLIENT_ID=$(jq -r '.google.oauthClientId' "$CONFIG_FILE")
  GOOGLE_CLIENT_SECRET=$(jq -r '.google.oauthClientSecret' "$CONFIG_FILE")
  APP_URL=$(jq -r '.appUrl' "$CONFIG_FILE")
else
  bold "\nStep 1: Project configuration"
  echo ""
  read -r -p "  Firebase project ID: " PROJECT_ID
  [[ -n "$PROJECT_ID" ]] || die "Project ID cannot be empty."

  read -r -p "  Region [us-central1]: " REGION
  REGION="${REGION:-us-central1}"

  read -r -p "  Admin email address: " ADMIN_EMAIL
  [[ -n "$ADMIN_EMAIL" ]] || die "Admin email cannot be empty."

  read -r -p "  Google OAuth Client ID: " GOOGLE_CLIENT_ID
  read -r -s -p "  Google OAuth Client Secret: " GOOGLE_CLIENT_SECRET
  echo ""

  bold "\nStep 1b: Firebase web app config"
  yellow "  Find this in: Firebase Console → Project Settings → Your Apps → SDK setup"
  echo ""
  read -r -p "  Firebase API Key: " FIREBASE_API_KEY
  read -r -p "  Firebase Auth Domain [${PROJECT_ID}.firebaseapp.com]: " FIREBASE_AUTH_DOMAIN
  FIREBASE_AUTH_DOMAIN="${FIREBASE_AUTH_DOMAIN:-${PROJECT_ID}.firebaseapp.com}"
  read -r -p "  Firebase Storage Bucket [${PROJECT_ID}.firebasestorage.app]: " FIREBASE_STORAGE_BUCKET
  FIREBASE_STORAGE_BUCKET="${FIREBASE_STORAGE_BUCKET:-${PROJECT_ID}.firebasestorage.app}"
  read -r -p "  Firebase Messaging Sender ID: " FIREBASE_MESSAGING_SENDER_ID
  read -r -p "  Firebase App ID: " FIREBASE_APP_ID

  read -r -p "  Asana OAuth Client ID (leave blank to configure later): " ASANA_CLIENT_ID
  read -r -s -p "  Asana OAuth Client Secret (leave blank to configure later): " ASANA_CLIENT_SECRET
  echo ""
  read -r -p "  Hosting site name (leave blank if same as project ID): " HOSTING_SITE
  APP_URL="https://${HOSTING_SITE:-${PROJECT_ID}}.web.app"
  KMS_KEY_NAME="projects/${PROJECT_ID}/locations/${REGION}/keyRings/taskbot-keyring/cryptoKeys/taskbot-key"

  # Write config
  jq -n \
    --arg pid "$PROJECT_ID" \
    --arg region "$REGION" \
    --arg gcid "$GOOGLE_CLIENT_ID" \
    --arg gcs "$GOOGLE_CLIENT_SECRET" \
    --arg kms "$KMS_KEY_NAME" \
    --arg email "$ADMIN_EMAIL" \
    --arg url "$APP_URL" \
    --arg site "$HOSTING_SITE" \
    --arg asanaId "$ASANA_CLIENT_ID" \
    --arg asanaSecret "$ASANA_CLIENT_SECRET" \
    --arg fbApiKey "$FIREBASE_API_KEY" \
    --arg fbAuthDomain "$FIREBASE_AUTH_DOMAIN" \
    --arg fbBucket "$FIREBASE_STORAGE_BUCKET" \
    --arg fbSenderId "$FIREBASE_MESSAGING_SENDER_ID" \
    --arg fbAppId "$FIREBASE_APP_ID" \
    '{
      projectId: $pid,
      region: $region,
      google: { oauthClientId: $gcid, oauthClientSecret: $gcs },
      kms: { keyName: $kms },
      adminEmail: $email,
      appUrl: $url,
      hostingSite: (if $site == "" then null else $site end),
      asana: { clientId: $asanaId, clientSecret: $asanaSecret },
      firebase: {
        apiKey: $fbApiKey,
        authDomain: $fbAuthDomain,
        storageBucket: $fbBucket,
        messagingSenderId: $fbSenderId,
        appId: $fbAppId
      }
    }' > "$CONFIG_FILE"

  green "  Config saved to: $CONFIG_FILE"
fi

KMS_KEY_NAME=$(jq -r '.kms.keyName' "$CONFIG_FILE")

bold "\nConfiguration summary:"
echo "  Client:       $CLIENT"
echo "  Project ID:   $PROJECT_ID"
echo "  Region:       $REGION"
echo "  Admin email:  $ADMIN_EMAIL"
echo "  App URL:      $APP_URL"
echo ""
confirm "Proceed with deployment?" || die "Aborted."

# ── Step 2: Switch Firebase project ───────────────────────────────────────────

bold "\nStep 2: Switching to Firebase project $PROJECT_ID"
firebase use "$PROJECT_ID" --non-interactive 2>/dev/null || \
  firebase use --add "$PROJECT_ID" --alias "$CLIENT"

# ── Step 3: Enable APIs ────────────────────────────────────────────────────────

bold "\nStep 3: Enabling required Google Cloud APIs"
APIS=(
  firestore.googleapis.com
  cloudfunctions.googleapis.com
  cloudbuild.googleapis.com
  run.googleapis.com
  eventarc.googleapis.com
  artifactregistry.googleapis.com
  firebase.googleapis.com
  cloudkms.googleapis.com
  drive.googleapis.com
  gmail.googleapis.com
  tasks.googleapis.com
)
for api in "${APIS[@]}"; do
  printf "  Enabling %s ... " "$api"
  gcloud services enable "$api" --project="$PROJECT_ID" --quiet
  green "done"
done

# ── Step 3b: Grant Cloud Build & Compute service account permissions ───────────
# Required for 2nd gen Cloud Functions under org policies that restrict defaults.

bold "\nStep 3b: Granting Cloud Build and Compute service account permissions"
PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
COMPUTE_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"
CLOUDBUILD_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

for role in roles/logging.logWriter roles/storage.objectViewer roles/artifactregistry.writer; do
  printf "  Granting %s to compute SA ... " "$role"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${COMPUTE_SA}" \
    --role="$role" --quiet 2>/dev/null && green "done" || yellow "skipped (may already exist)"
done

for role in roles/storage.objectAdmin roles/logging.logWriter roles/artifactregistry.writer roles/cloudbuild.builds.builder; do
  printf "  Granting %s to cloudbuild SA ... " "$role"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${CLOUDBUILD_SA}" \
    --role="$role" --quiet 2>/dev/null && green "done" || yellow "skipped (may already exist)"
done

# ── Step 4: Create KMS key ring and key ───────────────────────────────────────

bold "\nStep 4: Setting up Cloud KMS"
KMS_RING="taskbot-keyring"
KMS_KEY="taskbot-key"

if gcloud kms keyrings describe "$KMS_RING" \
     --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  yellow "  Key ring '$KMS_RING' already exists — skipping creation."
else
  printf "  Creating key ring '%s' ... " "$KMS_RING"
  gcloud kms keyrings create "$KMS_RING" \
    --location="$REGION" --project="$PROJECT_ID"
  green "done"
fi

if gcloud kms keys describe "$KMS_KEY" \
     --keyring="$KMS_RING" --location="$REGION" --project="$PROJECT_ID" &>/dev/null; then
  yellow "  Crypto key '$KMS_KEY' already exists — skipping creation."
else
  printf "  Creating crypto key '%s' ... " "$KMS_KEY"
  gcloud kms keys create "$KMS_KEY" \
    --keyring="$KMS_RING" \
    --location="$REGION" \
    --purpose=encryption \
    --project="$PROJECT_ID"
  green "done"
fi

NEEDS_KMS_GRANT=false
# Grant the default Cloud Functions service account KMS encrypt/decrypt.
# This service account is created on first Cloud Functions deploy, so we
# attempt it here and again after functions deploy if it fails.
SA="${PROJECT_ID}@appspot.gserviceaccount.com"
grant_kms() {
  gcloud kms keys add-iam-policy-binding "$KMS_KEY" \
    --keyring="$KMS_RING" \
    --location="$REGION" \
    --member="serviceAccount:${SA}" \
    --role="roles/cloudkms.cryptoKeyEncrypterDecrypter" \
    --project="$PROJECT_ID" \
    --quiet 2>/dev/null
}
printf "  Granting KMS roles to %s ... " "$SA"
if grant_kms; then
  green "done"
else
  yellow "skipped (service account not yet created — will retry after functions deploy)"
  NEEDS_KMS_GRANT=true
fi

# ── Step 5: Deploy Firestore indexes and security rules ───────────────────────

bold "\nStep 5: Deploying Firestore indexes and security rules"
cd "$REPO_ROOT"
firebase deploy --only firestore --project="$PROJECT_ID"

# ── Step 6: Set environment variables ─────────────────────────────────────────

bold "\nStep 6: Setting environment variables"
# Write per-project functions env file — Firebase CLI uploads this automatically.
cat > "$REPO_ROOT/functions/.env.${PROJECT_ID}" <<EOF
GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID}
GOOGLE_CLIENT_SECRET=${GOOGLE_CLIENT_SECRET}
OAUTH_REDIRECT_URI=https://us-central1-${PROJECT_ID}.cloudfunctions.net/oauthCallback
OAUTH_SUCCESS_REDIRECT=${APP_URL}
ASANA_CLIENT_ID=${ASANA_CLIENT_ID:-}
ASANA_CLIENT_SECRET=${ASANA_CLIENT_SECRET:-}
ASANA_REDIRECT_URI=${APP_URL}/api/auth/asana/callback
KMS_KEY_NAME=${KMS_KEY_NAME}
EOF
green "  Environment variables written to functions/.env.${PROJECT_ID}"

# ── Step 7: Build and deploy Cloud Functions ──────────────────────────────────

bold "\nStep 7: Deploying Cloud Functions"
npm --prefix "$REPO_ROOT/functions" run build
firebase deploy --only functions --project="$PROJECT_ID"

# Retry KMS grant now that functions deploy has created the service account
if [[ "${NEEDS_KMS_GRANT:-}" == "true" ]]; then
  printf "  Retrying KMS grant for %s ... " "$SA"
  if grant_kms; then
    green "done"
  else
    yellow "WARNING: KMS grant failed — run manually:"
    yellow "  gcloud kms keys add-iam-policy-binding taskbot-key \\"
    yellow "    --keyring=taskbot-keyring --location=$REGION \\"
    yellow "    --member=serviceAccount:${SA} \\"
    yellow "    --role=roles/cloudkms.cryptoKeyEncrypterDecrypter \\"
    yellow "    --project=$PROJECT_ID"
  fi
fi

# ── Step 8: Deploy Hosting ────────────────────────────────────────────────────

bold "\nStep 8: Deploying Hosting"
firebase deploy --only hosting --project="$PROJECT_ID"

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
green "Client '$CLIENT' successfully deployed!"
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  App URL:       $APP_URL"
echo "  Admin email:   $ADMIN_EMAIL"
echo ""
echo "  Next steps:"
echo "  1. Sign in at $APP_URL using the admin Google account ($ADMIN_EMAIL)."
echo "     The first user to sign in will automatically become admin."
echo "  2. Open the Admin Panel and configure:"
echo "     - AI credentials (Anthropic or OpenAI key)"
echo "     - Slack bot token (optional)"
echo "  3. Each user connects their own Google Tasks / Asana from Settings."
echo ""
echo "  To deploy updates later:"
echo "    ./deploy/deploy.sh $CLIENT"
echo "    ./deploy/deploy.sh $CLIENT --only functions"
echo ""
