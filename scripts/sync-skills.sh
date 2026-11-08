#!/usr/bin/env sh
# Copy the skills that `npm create mnx` ships into its shared template. Run after editing
# skills/mnx-component or skills/mnx-consume; skills/test/skills.test.js checks the copies.
set -e
cd "$(dirname "$0")/.."
for skill in mnx-component mnx-consume; do
  mkdir -p "create/templates/shared/skills/$skill"
  cp "skills/$skill/SKILL.md" "create/templates/shared/skills/$skill/SKILL.md"
done
echo "synced"
