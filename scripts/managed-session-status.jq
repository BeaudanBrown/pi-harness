# Runtime observations are not cursor/delivery authority. Emit only aggregate
# state and freshness, never cursor tokens, room IDs, input or error contents.
($health[0] | {
  status,
  lastSuccessfulSyncAt,
  ready: (.status == "healthy" and .lastSuccessfulSyncAt != null and
    ((now - (.lastSuccessfulSyncAt | sub("[.][0-9]+Z$"; "Z") | fromdateiso8601)) as $age | $age >= 0 and $age < 120))
}) as $sync |
{
  service: "active",
  socket: "ready",
  runtime: {
    running: ($health[0].runtimeBuild // "unknown"),
    installed: ($ARGS.named.desiredRuntime // "unknown"),
    updatePending: (($ARGS.named.desiredRuntime // null) != null and $health[0].runtimeBuild != $ARGS.named.desiredRuntime)
  },
  pendingInputs: ([.conversations[]?.pendingInputs[]? | select(.status != "completed" and .status != "cancelled")] | length),
  pendingProjections: ([.conversations[]?.projection[]? | select(.status != "projected")] | length),
  conversations: (.conversations | length),
  states: (.conversations | group_by(.state) | map({key: .[0].state, value: length}) | from_entries),
  cursorConfigured: any(.conversations[]?; .matrixCursor.status == "established"),
  sync: $sync,
  pendingProjectReconciliation: $pending
}
