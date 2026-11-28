#!/usr/bin/env bash
# Approve a version for the bar: starts the promote-to-bar workflow on GitHub.
#   scripts/promote-to-bar.sh [--dry-run] [<sha>]     (default sha = origin/main)
# Only cj-castro can pass the workflow's check. The token comes from
# `git credential fill` and is never printed.
set -euo pipefail
set +x

REPO="cj-castro/billar-pos"
WORKFLOW="promote-to-bar.yml"
dry_run=0
sha=""
for a in "$@"; do
  case "$a" in
    --dry-run) dry_run=1 ;;
    -h|--help) sed -n '2,5p' "$0"; exit 0 ;;
    -*) echo "Unknown option: $a" >&2; exit 2 ;;
    *) sha="$a" ;;
  esac
done

git fetch --quiet origin main
if [ -z "$sha" ]; then
  sha=$(git rev-parse origin/main)
fi
if ! printf '%s' "$sha" | grep -Eq '^[0-9a-fA-F]{7,40}$'; then
  echo "sha must be 7 to 40 hex characters: $sha" >&2
  exit 2
fi

full=$(git rev-parse --verify --quiet "${sha}^{commit}") || { echo "Commit not found locally: $sha" >&2; exit 2; }
echo "Commit: $full"
echo "Subject: $(git log -1 --format=%s "$full")"

body=$(printf '{"ref":"main","inputs":{"sha":"%s"}}' "$sha")

if [ "$dry_run" = 1 ]; then
  echo "POST https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/dispatches"
  echo "$body"
  exit 0
fi

token=$(printf 'protocol=https\nhost=github.com\n\n' | git credential fill | sed -n 's/^password=//p')
if [ -z "$token" ]; then
  echo "No GitHub credential found for github.com." >&2
  exit 1
fi

# The header goes through a curl config on stdin, so the token is not in argv.
code=$(printf 'header = "Authorization: Bearer %s"\n' "$token" | curl -sS -o /dev/null -w '%{http_code}' \
  --config - \
  -X POST \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2022-11-28" \
  --data "$body" \
  "https://api.github.com/repos/$REPO/actions/workflows/$WORKFLOW/dispatches") || code="000"
unset token

if [ "$code" != "204" ]; then
  echo "GitHub answered HTTP $code. Nothing was started." >&2
  exit 1
fi
echo "Started. Watch it here:"
echo "https://github.com/$REPO/actions/workflows/$WORKFLOW"
