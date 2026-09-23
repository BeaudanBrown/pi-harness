#!/usr/bin/env bash
# Fixed host-owned arguments, not an adapter/model-facing command surface.
set -euo pipefail
if [[ $# != 2 ]]; then
  echo 'Usage: relay-rollout GUARD RELAY_UNIT' >&2
  exit 2
fi
"$1"
# Submit one restart transaction. The manager, not this client, owns the job.
systemctl --user restart "$2"
