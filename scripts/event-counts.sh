#!/usr/bin/env bash
# Prints the app's anonymous step counts (web/src/count.ts) from Cloudflare's request analytics: event-counts.sh [hours, default 24].
set -euo pipefail
HOURS="${1:-24}"
ZONE="${CF_ZONE_ID:-a9f689f4ab26af429bd69d5156413d4f}"   # gridfinitytools.com
CFG="$HOME/Library/Preferences/.wrangler/config/default.toml"
(cd "$(dirname "$0")/../web" && npx --yes wrangler whoami >/dev/null 2>&1) || true   # refreshes the OAuth token
TOKEN="${CLOUDFLARE_API_TOKEN:-$(grep '^oauth_token' "$CFG" | cut -d'"' -f2)}"
SINCE="$(date -u -v-"${HOURS}"H +%FT%TZ 2>/dev/null || date -u -d "-${HOURS} hours" +%FT%TZ)"
QUERY=$(printf '{"query":"{ viewer { zones(filter:{zoneTag:\\"%s\\"}) { httpRequestsAdaptiveGroups(limit:50, filter:{datetime_geq:\\"%s\\", clientRequestPath_like:\\"/e/%%\\"}) { count dimensions { clientRequestPath } } } } }"}' "$ZONE" "$SINCE")
curl -fsS -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  https://api.cloudflare.com/client/v4/graphql -d "$QUERY" | python3 -I -c '
import json, sys
r = json.load(sys.stdin)
if r.get("errors"):
    sys.exit("Cloudflare: " + r["errors"][0]["message"])
counts = {g["dimensions"]["clientRequestPath"][3:-4]: g["count"] for g in r["data"]["viewer"]["zones"][0]["httpRequestsAdaptiveGroups"]}
order = ["upload-start", "model-yes", "model-no", "upload-ok", "upload-no-sheet", "upload-no-tool", "upload-cut-off",
         "upload-error-decode", "upload-error-model", "upload-error-memory", "upload-error",
         "export-stl", "export-svg", "export-dxf"]
for k in order + sorted(set(counts) - set(order)):
    print(f"{k:20} {counts.get(k, 0)}")
'
echo "(last ${HOURS} h, gridfinitytools.com only)"
