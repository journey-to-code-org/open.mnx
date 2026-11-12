#!/usr/bin/env bash
# Opens an issue for a failed canary job (.github/workflows/canary.yml), or comments on the open one
# with the same title, so a failure that lasts several weeks is one issue with a comment a week.
#   bash scripts/canary-issue.sh "<what failed>"
set -euo pipefail

title="Canary: $1"
run="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY/actions/runs/$GITHUB_RUN_ID"
summary="${GITHUB_STEP_SUMMARY:-}"
body="The weekly canary failed: **$1**. [The run]($run) has the log; the versions it moved to are below.

$( [ -n "$summary" ] && [ -f "$summary" ] && cat "$summary" )

Either a framework release changed something an adapter relies on (fix it, and the pinned versions move up with the fix), or the release itself is broken (note it here and close this when it's fixed upstream)."

gh label create canary --color FBCA04 --description "A framework release breaks an adapter or example" --force > /dev/null
number=$(gh issue list --label canary --state open --json number,title --jq ".[] | select(.title == \"$title\") | .number" | head -n 1)
if [ -n "$number" ]; then
  gh issue comment "$number" --body "$body"
else
  gh issue create --title "$title" --label canary --body "$body"
fi
