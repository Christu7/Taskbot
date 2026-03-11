#!/usr/bin/env bash
# ─── TaskBot API Test Suite ────────────────────────────────────────────────────
# Tests core API routing, auth middleware, admin guards, and rate limiting
# against the Firebase local emulators.
#
# Prerequisites:
#   1. cd /path/to/Taskbot
#   2. (cd functions && npm run build)
#   3. firebase emulators:start         ← keep running in a separate terminal
#   4. ./scripts/test-api.sh            ← run this script
# ──────────────────────────────────────────────────────────────────────────────

set -uo pipefail

# ─── Config ──────────────────────────────────────────────────────────────────
PROJECT_ID="taskbot-fb10d"
REGION="us-central1"
API_BASE="http://127.0.0.1:5001/${PROJECT_ID}/${REGION}/api"
AUTH_BASE="http://127.0.0.1:9099"
FS_BASE="http://127.0.0.1:8080/v1/projects/${PROJECT_ID}/databases/(default)/documents"

ADMIN_EMAIL="testadmin@taskbot.local"
USER_EMAIL="testuser@taskbot.local"
RL_EMAIL="ratelimit@taskbot.local"   # dedicated user for rate-limit test
PASS="TestPass123!"

# ─── Colors ──────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

PASS_COUNT=0
FAIL_COUNT=0

pass()    { echo -e "  ${GREEN}✓${NC} $1"; PASS_COUNT=$((PASS_COUNT + 1)); }
fail()    { echo -e "  ${RED}✗${NC} $1"; FAIL_COUNT=$((FAIL_COUNT + 1)); }
info()    { echo -e "  ${YELLOW}→${NC} $1"; }
section() { echo -e "\n${BOLD}$1${NC}"; echo "  ──────────────────────────────────────"; }

check() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" -eq "$expected" ]; then
    pass "$label (HTTP $actual)"
  else
    fail "$label — expected HTTP $expected, got $actual"
  fi
}

# ─── jq-free JSON field extractor ────────────────────────────────────────────
# Usage: json_get <json_string> <field_name>
json_get() { echo "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
json_has() { echo "$1" | grep -q "\"$2\""; }

# ─── Single-call helper: sets $RESP (body) and $CURL_STATUS (HTTP code) ───────
# Usage: curl_json <curl-args...>   then use $CURL_STATUS and $RESP
# Must NOT be called in a subshell $() — call directly so globals propagate.
RESP=""
CURL_STATUS=""
curl_json() {
  local _tmp
  _tmp=$(mktemp)
  CURL_STATUS=$(curl -s -o "$_tmp" -w "%{http_code}" "$@")
  RESP=$(cat "$_tmp")
  rm -f "$_tmp"
}

# ─── Auth emulator helpers ────────────────────────────────────────────────────
signup_or_signin() {
  local email="$1"
  local resp
  # Try sign-up first
  resp=$(curl -sf -X POST \
    "${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=test" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${email}\",\"password\":\"${PASS}\",\"returnSecureToken\":true}" 2>/dev/null || true)

  if [ -z "$(json_get "$resp" "idToken")" ]; then
    # Already exists — sign in instead
    resp=$(curl -sf -X POST \
      "${AUTH_BASE}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=test" \
      -H "Content-Type: application/json" \
      -d "{\"email\":\"${email}\",\"password\":\"${PASS}\",\"returnSecureToken\":true}" 2>/dev/null || true)
  fi
  echo "$resp"
}

# ─── Firestore emulator helpers ───────────────────────────────────────────────
# Seeds a user document directly so requireAdmin middleware can read role
seed_user() {
  local uid="$1" email="$2" role="$3"
  curl -sf -X PATCH \
    "${FS_BASE}/users/${uid}" \
    -H "Content-Type: application/json" \
    -d "{\"fields\":{
      \"uid\":      {\"stringValue\":\"${uid}\"},
      \"email\":    {\"stringValue\":\"${email}\"},
      \"role\":     {\"stringValue\":\"${role}\"},
      \"isActive\": {\"booleanValue\":true},
      \"hasValidTokens\": {\"booleanValue\":true},
      \"preferences\": {\"mapValue\":{\"fields\":{
        \"notifyVia\":            {\"arrayValue\":{\"values\":[{\"stringValue\":\"email\"}]}},
        \"autoApprove\":          {\"booleanValue\":false},
        \"proposalExpiryHours\":  {\"integerValue\":\"48\"}
      }}}
    }}" > /dev/null
}

# ─────────────────────────────────────────────────────────────────────────────
echo -e "\n${BOLD}TaskBot API Test Suite${NC}"
echo "  Project : ${PROJECT_ID}"
echo "  API     : ${API_BASE}"

# ─── 0. Check emulators ───────────────────────────────────────────────────────
section "0. Checking emulators"

AUTH_UP=$(curl -s -o /dev/null -w "%{http_code}" \
  "${AUTH_BASE}/identitytoolkit.googleapis.com/v1/projects" 2>/dev/null || echo "0")
if [ "$AUTH_UP" = "0" ] || [ "$AUTH_UP" = "000" ]; then
  echo -e "\n  ${RED}ERROR: Auth emulator not reachable at ${AUTH_BASE}${NC}"
  echo "  Make sure you ran:  firebase emulators:start"
  exit 1
fi
pass "Auth emulator reachable (port 9099)"

API_UP=$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE}/settings" 2>/dev/null || echo "0")
if [ "$API_UP" = "000" ]; then
  echo -e "\n  ${RED}ERROR: Functions emulator not reachable at port 5001${NC}"
  echo "  Make sure you ran:  firebase emulators:start"
  exit 1
fi
pass "Functions emulator reachable (port 5001)"

# ─── 1. Create test users ─────────────────────────────────────────────────────
section "1. Creating test users"

info "Signing up admin user..."
ADMIN_RESP=$(signup_or_signin "$ADMIN_EMAIL")
ADMIN_TOKEN=$(json_get "$ADMIN_RESP" "idToken")
ADMIN_UID=$(json_get "$ADMIN_RESP" "localId")

info "Signing up regular user..."
USER_RESP=$(signup_or_signin "$USER_EMAIL")
USER_TOKEN=$(json_get "$USER_RESP" "idToken")
USER_UID=$(json_get "$USER_RESP" "localId")

info "Signing up rate-limit test user..."
RL_RESP=$(signup_or_signin "$RL_EMAIL")
RL_TOKEN=$(json_get "$RL_RESP" "idToken")
RL_UID=$(json_get "$RL_RESP" "localId")

if [ -z "$ADMIN_TOKEN" ] || [ -z "$USER_TOKEN" ] || [ -z "$RL_TOKEN" ]; then
  echo -e "\n  ${RED}ERROR: Could not obtain auth tokens. Is the Auth emulator running?${NC}"
  exit 1
fi

pass "Tokens obtained (admin: ${ADMIN_UID:0:8}…, user: ${USER_UID:0:8}…, rl: ${RL_UID:0:8}…)"

# Wait for onUserCreated triggers to complete. All three users are created in
# quick succession so isFirstUser() races — all three end up as admin.
# We wait here then use the admin API itself to set the correct roles.
info "Waiting for onUserCreated triggers (5s)..."
sleep 5

# Seed basic Firestore docs (needed for users that may not have a doc yet)
info "Seeding Firestore user docs..."
seed_user "$ADMIN_UID" "$ADMIN_EMAIL" "admin"
seed_user "$USER_UID"  "$USER_EMAIL"  "admin"   # start as admin so API works
seed_user "$RL_UID"    "$RL_EMAIL"    "admin"
sleep 1

# Demote USER_UID to regular user via the actual admin API (reliable, no REST quirks)
info "Demoting test user to 'user' role via admin API..."
DEMOTE_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"role":"user"}' \
  "${API_BASE}/admin/users/${USER_UID}/role")
if [ "$DEMOTE_STATUS" = "200" ]; then
  pass "Roles set: admin=admin, user=user, rl=admin"
else
  fail "Could not demote test user (HTTP ${DEMOTE_STATUS}) — access control tests may fail"
fi
sleep 1

# ─── 2. Auth middleware ───────────────────────────────────────────────────────
section "2. Auth middleware"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" "${API_BASE}/settings")
check "No token → 401" 401 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer not-a-real-token" "${API_BASE}/settings")
check "Invalid token → 401" 401 "$STATUS"

# ─── 3. Settings ─────────────────────────────────────────────────────────────
section "3. Settings"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" "${API_BASE}/settings")
check "GET /settings (admin) → 200" 200 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${USER_TOKEN}" "${API_BASE}/settings")
check "GET /settings (user) → 200" 200 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"isActive":true,"preferences":{"autoApprove":false,"proposalExpiryHours":48,"notifyVia":["email"]}}' \
  "${API_BASE}/settings")
check "PATCH /settings → 200" 200 "$STATUS"

# ─── 4. Awaiting config count ─────────────────────────────────────────────────
section "4. Awaiting configuration banner"

curl_json -H "Authorization: Bearer ${ADMIN_TOKEN}" "${API_BASE}/transcripts/awaiting"
check "GET /transcripts/awaiting → 200" 200 "$CURL_STATUS"
if json_has "$RESP" "count"; then
  pass "Response contains 'count' field"
else
  fail "Response missing 'count' field (got: ${RESP:0:100})"
fi

# ─── 5. Admin — access control ────────────────────────────────────────────────
section "5. Admin access control"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${USER_TOKEN}" "${API_BASE}/admin/users")
check "GET /admin/users as regular user → 403" 403 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${USER_TOKEN}" "${API_BASE}/admin/setup-status")
check "GET /admin/setup-status as regular user → 403" 403 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${USER_TOKEN}" "${API_BASE}/admin/dashboard")
check "GET /admin/dashboard as regular user → 403" 403 "$STATUS"

# ─── 6. Admin — setup wizard ──────────────────────────────────────────────────
section "6. Setup wizard"

curl_json -H "Authorization: Bearer ${ADMIN_TOKEN}" "${API_BASE}/admin/setup-status"
check "GET /admin/setup-status → 200" 200 "$CURL_STATUS"
if json_has "$RESP" "completed"; then
  pass "Response contains 'completed' field"
else
  fail "Response missing 'completed' field (got: ${RESP:0:100})"
fi

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  "${API_BASE}/admin/setup-complete")
check "POST /admin/setup-complete → 200" 200 "$STATUS"

# Verify it's now marked complete
curl_json -H "Authorization: Bearer ${ADMIN_TOKEN}" "${API_BASE}/admin/setup-status"
if echo "$RESP" | grep -q '"completed":true'; then
  pass "setup-status.completed is now true"
else
  fail "setup-status.completed not set to true (got: ${RESP:0:100})"
fi

# ─── 7. Admin — users ─────────────────────────────────────────────────────────
section "7. User management"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" "${API_BASE}/admin/users")
check "GET /admin/users → 200" 200 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" "${API_BASE}/admin/users/stats")
check "GET /admin/users/stats → 200" 200 "$STATUS"

# Last-admin demotion guard (ADMIN_UID is the only admin; RL_UID is also admin but
# the guard counts admins in the collection — 2 exist so this should succeed…
# but let's test demoting the RL user first to get to 1 admin, then try)
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"role":"user"}' \
  "${API_BASE}/admin/users/${RL_UID}/role")
check "Demote RL user (2 admins exist) → 200" 200 "$STATUS"

# Now only ADMIN_UID is admin — trying to demote them should 400
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"role":"user"}' \
  "${API_BASE}/admin/users/${ADMIN_UID}/role")
check "Demote last admin → 400" 400 "$STATUS"

# Promote regular user
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X PATCH \
  -H "Authorization: Bearer ${ADMIN_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}' \
  "${API_BASE}/admin/users/${USER_UID}/role")
check "Promote regular user → 200" 200 "$STATUS"

# ─── 8. Admin — dashboard & activity ─────────────────────────────────────────
# USER_TOKEN was promoted to admin in section 7 — use it here (fresh rate-limit window)
section "8. Dashboard & activity log"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${USER_TOKEN}" "${API_BASE}/admin/dashboard")
check "GET /admin/dashboard → 200" 200 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -H "Authorization: Bearer ${USER_TOKEN}" "${API_BASE}/admin/activity")
check "GET /admin/activity → 200" 200 "$STATUS"

# ─── 9. Admin — export ────────────────────────────────────────────────────────
section "9. Data export"

curl_json -X POST \
  -H "Authorization: Bearer ${USER_TOKEN}" \
  "${API_BASE}/admin/export"
check "POST /admin/export → 200" 200 "$CURL_STATUS"

# Verify export doesn't include secrets
if echo "$RESP" | grep -q "apiKey\|botToken\|signingSecret\|clientSecret"; then
  fail "Export contains secret fields — security issue!"
else
  pass "Export does not leak secret fields"
fi

# ─── 10. Rate limiting ────────────────────────────────────────────────────────
section "10. Rate limiting (10 req/min per user)"

# RL user was demoted to 'user' in section 7.
# Re-promote via USER_TOKEN (which has a fresh rate-limit window — it was just promoted to admin)
info "Re-promoting RL user to admin for rate-limit test..."
curl -s -o /dev/null \
  -X PATCH \
  -H "Authorization: Bearer ${USER_TOKEN}" \
  -H "Content-Type: application/json" \
  -d '{"role":"admin"}' \
  "${API_BASE}/admin/users/${RL_UID}/role"
sleep 1

info "Firing 11 rapid requests with RL user token..."
RL_FAIL=0
for i in $(seq 1 11); do
  SC=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "Authorization: Bearer ${RL_TOKEN}" \
    "${API_BASE}/admin/dashboard")
  if [ "$i" -le 10 ] && [ "$SC" -ne 200 ]; then
    fail "Request ${i}/11 failed unexpectedly (HTTP ${SC})"
    RL_FAIL=1
    break
  fi
  if [ "$i" -eq 11 ]; then
    if [ "$SC" -eq 429 ]; then
      pass "Request 11 rate-limited (HTTP 429) — window enforced"
    else
      fail "Request 11 was NOT rate-limited (HTTP ${SC}) — expected 429"
    fi
  fi
done

# ─── Results ──────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo -e "${BOLD}  Results: ${GREEN}${PASS_COUNT} passed${NC}  ${RED}${FAIL_COUNT} failed${NC}${BOLD}  (of $((PASS_COUNT + FAIL_COUNT)) checks)${NC}"
echo -e "${BOLD}══════════════════════════════════════════${NC}"
echo ""

[ "$FAIL_COUNT" -eq 0 ] && exit 0 || exit 1
