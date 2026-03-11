#!/usr/bin/env bash
# deploy-all.sh — Deploy TaskBot updates to all configured client projects.
# Usage: ./deploy-all.sh [--only functions|hosting|rules|firestore]
# Examples:
#   ./deploy-all.sh
#   ./deploy-all.sh --only functions

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIGS_DIR="$SCRIPT_DIR/configs"

# ── Helpers ───────────────────────────────────────────────────────────────────

bold()   { printf "\033[1m%s\033[0m\n" "$*"; }
green()  { printf "\033[32m%s\033[0m\n" "$*"; }
red()    { printf "\033[31m%s\033[0m\n" "$*"; }
yellow() { printf "\033[33m%s\033[0m\n" "$*"; }

# ── Args ──────────────────────────────────────────────────────────────────────

ONLY_ARGS=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --only)
      [[ $# -ge 2 ]] || { red "ERROR: --only requires a target"; exit 1; }
      ONLY_ARGS="--only $2"
      shift 2
      ;;
    *)
      red "ERROR: Unknown argument: $1"
      exit 1
      ;;
  esac
done

# ── Discover clients ──────────────────────────────────────────────────────────

CONFIGS=()
while IFS= read -r -d '' f; do
  CLIENT=$(basename "$f" .json)
  [[ "$CLIENT" == "template" ]] && continue
  CONFIGS+=("$CLIENT")
done < <(find "$CONFIGS_DIR" -maxdepth 1 -name "*.json" ! -name "template.json" -print0 | sort -z)

if [[ ${#CONFIGS[@]} -eq 0 ]]; then
  yellow "No client configs found in $CONFIGS_DIR (excluding template.json)."
  yellow "Run ./setup-new-client.sh <name> to create one."
  exit 0
fi

TOTAL=${#CONFIGS[@]}
bold ""
bold "TaskBot — Deploy All (${TOTAL} client$([ "$TOTAL" -ne 1 ] && echo s || true))"
if [[ -n "$ONLY_ARGS" ]]; then
  bold "  Target: ${ONLY_ARGS#--only }"
fi
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

FAILED=()
PASSED=()

for i in "${!CONFIGS[@]}"; do
  CLIENT="${CONFIGS[$i]}"
  NUM=$((i + 1))
  printf "Deploying to \033[1m%s\033[0m (%d/%d)... " "$CLIENT" "$NUM" "$TOTAL"

  # Run deploy.sh and capture output; show on failure
  set +e
  # shellcheck disable=SC2086
  OUTPUT=$("$SCRIPT_DIR/deploy.sh" "$CLIENT" $ONLY_ARGS 2>&1)
  EXIT_CODE=$?
  set -e

  if [[ $EXIT_CODE -eq 0 ]]; then
    green "✓"
    PASSED+=("$CLIENT")
  else
    red "✗"
    red "  Failed output:"
    echo "$OUTPUT" | sed 's/^/  /'
    FAILED+=("$CLIENT")
  fi
done

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
bold "Results: ${#PASSED[@]} succeeded, ${#FAILED[@]} failed"
bold "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

if [[ ${#PASSED[@]} -gt 0 ]]; then
  green "Succeeded: ${PASSED[*]}"
fi

if [[ ${#FAILED[@]} -gt 0 ]]; then
  red "Failed:    ${FAILED[*]}"
  echo ""
  echo "Re-run individual failures with:"
  for c in "${FAILED[@]}"; do
    echo "  ./deploy/deploy.sh $c $ONLY_ARGS"
  done
  exit 1
fi

echo ""
green "All deployments complete."
echo ""
