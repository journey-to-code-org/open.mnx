#!/usr/bin/env bash
# Installs Playwright browsers on a CI runner.
#
# `--with-deps` fetches system packages from Ubuntu's mirrors, and some runners
# intermittently can't resolve them. Retry a few times; if the packages still
# can't be fetched, install the browsers alone, since the runner image already
# has most of what they need.
#
#   scripts/install-browsers.sh chromium
#   PLAYWRIGHT="python -m playwright" scripts/install-browsers.sh chromium
set -u
playwright=${PLAYWRIGHT:-npx playwright}
for attempt in 1 2 3; do
  $playwright install --with-deps "$@" && exit 0
  echo "::warning::playwright install --with-deps failed (attempt $attempt)"
  sleep $((attempt * 15))
done
echo "::warning::installing $* without system packages"
exec $playwright install "$@"
