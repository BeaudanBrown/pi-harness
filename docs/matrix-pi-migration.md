# Offline managed → native bridge migration (#169)

**Not permission to migrate or activate grill/NAS.** The implementation belongs
to #169; deletion belongs to #170, cumulative release/pin verification to #171,
and production cutover effects to #172. Development uses disposable directories,
owned test processes, synthetic read-only Nix fixtures and injected Matrix HTTP.
None of those is a production quiescence, Matrix membership or rollout receipt.

## Acceptance → evidence

| Acceptance | Implementation | Focused evidence |
| --- | --- | --- |
| Coherent inventory/backup; refuse writable/live sources | Explicit snapshot roots, Linux mount flags, no symlinks/special files/direct live aliases, sorted byte/digest inventory | Actual read-only Nix fixture versus writable/chmod-only source; complete raw export comparison; no-replace destinations |
| Original native files/IDs/rooms/grouping/policy; generations | Offline raw-format decoder, original paths/header IDs, current-file disambiguation, historical enrollment policy | Live/dormant/archive/retirement/generation/missing/damaged fixtures; unchanged JSONL; no active previous-generation binding |
| Frozen output identity and cutoff | Original rendered wire content/transactions; native conversion tail; old global/per-room intake cutoffs | Lost-ACK retry; first-chunk notification and historical wire-type assertions; unfrozen/held output retained unresolved |
| Unsent/uncertain input, polls and original media | Original event IDs; all historical work held; unattempted/uncertain distinction; inactive poll records; original image chunks | Never-attempted versus delivered/persisted; no old vote/task/control continuation; missing/corrupt media explicit; fresh input possible |
| No resurrection or terminal effects | Ledger identity/path policy; matching historical markers refuse an empty/wrong ledger; scoped original-room creator verification | Registration/projection cannot enable disabled/history identities; real Pi private-start regression; inaccessible/foreign rooms never replaced |
| Bounded report; deterministic distinct destination | Private sibling staging, transactional SQLite, complete receipt/report, no-replace publication | Duplicate imports byte-identical; exception and actual SIGKILL boundaries; foreign destination preserved |
| Rollback boundary | Read-only immutable SQLite check; durable first-runtime-writer marker | Pre-start ledger check; no sidecar creation; first writer/new work forbid automatic stale restoration |

See the issue evidence section in [bridge evidence](matrix-pi-bridge-evidence.md)
for commands, outcomes, review disposition and remaining release gates. The tests
are `tests/bridge-migration{,-process}.test.ts`, plus the affected native adapter,
store, history/delivery, organization, archive and sync suites.

## Tool and format

The separately packaged `matrix-bridge` output contains `bin/pi-bridge-migrate`:

```text
pi-bridge-migrate inventory SNAPSHOT
pi-bridge-migrate export SNAPSHOT NEW_BUNDLE
pi-bridge-migrate import READ_ONLY_BUNDLE NEW_STATE
pi-bridge-migrate check READ_ONLY_BUNDLE STATE
```

No command stops services, scans user processes, creates/mounts snapshots,
contacts Matrix, obtains credentials, runs Git, opens Pi, uploads artifacts,
replays queues or writes original histories. No automatic startup migration,
legacy runtime loader or repair API is installed by this tool.

Supported input is the reviewed legacy `schemaVersion: "1.0.0"` persistence,
version-one archive/retirement/inbox/hierarchy journals and complete native v3
JSONL. Room cursors must be the exact historical bootstrap/established union;
established room cutoffs require a coherent global inbox cutoff. All projection
transaction IDs, including sent/cancelled/unresolved records, remain reserved
against reuse. Unknown or partially converted legacy schemas fail explicitly. A missing
required archive/retirement store is not an empty store. Individual missing,
ambiguous or damaged native histories are retained/reported without replacement.
The raw backup preserves all files in the named roots, including opaque account
and terminal journals, historical generations and unrelated files. Nothing in
those terminal/account journals grants new execution or membership authority.

### Snapshot layout

The operator supplies `source.json` and independent copies/snapshots of the named
roots. Names are single directory components. This is an example schema, **not
actual deployment paths**:

```json
{
  "version": 1,
  "hostId": "host",
  "botUserId": "@pi-host:example.org",
  "operatorUserId": "@operator:example.org",
  "quiescence": "Reference to separately approved maintenance/exit/snapshot evidence",
  "roots": [
    { "role": "state", "name": "state", "original": "/old/configured/relay-state" },
    { "role": "manifests", "name": "manifests", "original": "/old/configured/manifests" },
    { "role": "native", "name": "native", "original": "/old/configured/project-sessions" },
    { "role": "native", "name": "ordinary", "original": "/old/configured/ordinary-sessions" },
    { "role": "account", "name": "account", "original": "/old/configured/account-state" }
  ],
  "unavailable": [],
  "currentFiles": {},
  "groupings": {}
}
```

- `state` contains the complete relay state: `registry.json`, `inbox.json`,
  `notice-outbox.json`, `archives.json`/presence marker, `retirements/` (including
  an empty directory), media spool, hierarchy/account/approval/terminal journals
  and other files. Do not cherry-pick just the registry. Do not include a live
  socket/runtime directory in place of persistent state.
- Include **every** ordinary/project/coordinator/historical native-session root,
  even if it overlaps bytes also retained within the raw state backup. Canonical
  absolute original paths are essential: the importer does not move native files.
- Include account-side metadata in the coherent maintenance backup, or explicitly
  describe its separately retained evidence in `unavailable`. Missing account
  evidence is reported, never interpreted as permission to replay account jobs.
- `currentFiles` optionally maps a native header ID to its exact original path.
  Use it when promotion/copies left multiple files with the same header identity.
  The selected file must exist in the frozen native roots and have that header.
  Without a unique proven file the identity stays disabled; no path is guessed.
- `groupings` maps exact conversation IDs to `{ "project": "/canonical/git/common-dir",
  "checkout": "/canonical/checkout-root" }`. Capture these read-only facts during
  approved quiescence, matching the native grouping contract (a plain non-Git cwd
  uses itself). The converter reuses original manifest room/Space IDs, not names
  or aliases. Missing/inconsistent mapping leaves grouping pending without
  inventing replacement Spaces. The original conversation can become usable
  independently once its own immutable creator/policy is verified.
- `quiescence` records operator evidence; the string itself is **not proof of
  exit**. A stale `active` registry row in a frozen snapshot is historical data,
  not a live process inspection and not something to repair by editing JSON.

A read-only mount alone does not establish coherent capture: a read-only bind of
live files still has writable aliases. First quiesce all approved old writers and
consumers, then capture an **independent** coherent snapshot/copy. The tool rejects
aliases of the declared original directories/files and requires read-only Linux
VFS mounts for every source file, including nested mounts. Chmod is insufficient;
a read-only Btrfs subvolume may also need a read-only mount to satisfy this check.
Privileged remounts and undeclared writable aliases are outside the tool's proof.
Its checks complement, never replace, maintenance evidence.

The synthetic fixture is placed in the read-only Nix store for tests only.
**Never put real histories, account journals or migration backups in the
world-readable Nix store.** Nix sandbox input binds can themselves have writable
VFS flags, so the deterministic gate gives only the synthetic fixture a private
read-only bind using bubblewrap while preserving the sandbox's device mounts,
UID, process semantics and test concurrency. This is test-only setup, not a
production dependency or weaker source check. Use private backup storage and
appropriate read-only mounts. Preserve modes/ownership needed to read the source; the tool creates new
backup/state files privately, not by chmodding originals.

### Conversion decisions

- Current readable files retain their original native header ID, canonical path,
  room and archive choice. Previous generations, retired/disabled identities,
  roomless incomplete enrollment and the former coordinator cannot enroll or
  acquire new active rooms. Their files remain local-readable. A genuine native
  fork/new session has a different identity and is not revival of terminal state.
- Native history is never rewritten. The new ledger cuts projection at the
  complete conversion tail. Unclassified/unfrozen old output is reported, not
  backfilled with a newly rendered or guessed transaction. Frozen text/checkpoint
  text/notice chunks retain historical event type, body/HTML, notification policy
  and original transaction. A legacy boolean `sent` is not a fabricated event ID.
  Repair-held output remains frozen but not executable.
- All unresolved historical input stays held. Known accepted-before-send input
  has an explicit never-attempted classification; delivered/persisted or otherwise
  uncertain work is interrupted. Both use the ledger's interrupted state to
  remain visible without being converted into a completed result. Original event
  IDs, raw context, poll IDs and required downloaded image bytes are retained.
  Old polls are inactive; pending publication/closure stays reported for receipt
  reconciliation. Undownloaded inbox media is reported, never fetched by migration.
- Fresh input is separate intent. Initial catch-up remains held, including old
  per-room gaps; only a subsequent caught-up sync releases the fence. Disabled
  historical rooms are not live sync consumers, so an old departed room cannot
  pin the host cursor. No old input, vote, approval, control or artifact upload
  automatically resumes.
- Imported rooms lack the new creation stamp. An exact offline imported receipt
  plus the **current immutable sole creator and room policy** is required before
  their remote delivery starts. Missing/foreign/inaccessible originals remain
  pending, never replaced. This is a small receipt exception, not a legacy live
  reader. Existing invitations/departures remain held: no automatic reinvitation,
  rejoin, leave/forget, notification repair or cleanup. Grouping reuses old Spaces;
  archive destination links precede removal of exact historical presentation
  edges, without deleting the old hierarchy or memberships.
- The first runtime writer opening an imported ledger sets a permanent started
  marker. That conservatively ends the automatic pre-start rollback check; it is
  **not proof that a model ran or an external effect completed**. Even a failed
  startup thereafter needs receipt reconciliation before any old-state restore.

### Outputs and retry

Export writes a new private bundle containing raw roots, a normalized descriptor
and `inventory.json`. Mount that independent bundle read-only before import or
check. Import creates a distinct state directory containing `bridge.sqlite`,
`migration-receipt.json` and `migration-report.json`; it never merges into an old
store. Preserve the bundle separately: the daemon does not read it.

Reports omit prompts, output bodies and credentials. They are bounded to 4,096
conversation rows, 16 short findings per row and 64 global findings, with explicit
omitted counts; the complete byte inventory/backup remains the detailed evidence.
Console output is only a short summary. A valid ledger is not proof of native
path accessibility, Matrix membership, process exit or cutover readiness.

Private `.<destination>-partial-*` siblings survive interruption. They are not
active state, and the tool neither adopts nor deletes them. Retry the same
command/destination: a complete identical export/import is checked read-only;
a foreign/different destination is rejected. A post-start ledger is never reset
by repeated import. Do not point a daemon at a partial sibling.

`check` uses SQLite's immutable URI only after rejecting WAL/SHM/rollback journal
evidence, and rechecks for concurrent change. Plain SQLite `readOnly` can create
WAL sidecars; it is insufficient. An interrupted/live destination with journals
must be preserved for separately approved offline reconciliation, not implicitly
checkpointed or repaired. Native file comparisons are observations, not a writer
lease or authorization to restore old queues.

## Operator runbook — separately approved #172 only

1. Obtain approval naming exact published revisions/host pins, grill/NAS scope,
   bot/account consumers, exact native writers, maintenance interval, snapshot
   roots and expected Matrix effects. #169 tests/builds/evaluations are not that
   approval. Retain the old installed Nix closures and complete configuration for
   a possible pre-cutover rollback. Do not activate merely to obtain the tool.
2. Inventory the **deployed** paths/configuration and selected identities, not
   guessed defaults. Include manifests, registry, native roots/generations,
   inbox/outbox, polls/media, archive/retirement/presence/terminal records and both
   host/account-side journals. Preserve unrelated worktrees/files/research and
   deliberate membership/notification decisions. Never inspect the private
   secrets repository; keep existing credential ownership/declarations unchanged.
3. Stop old Matrix/account consumers and prevent their automatic restart under
   the approved maintenance procedure. Stop only approved native writers through
   the existing consent-gated controls/human procedure. Do not kill shared tmux
   or unrelated sessions. Window/control ACKs, dormant records and unreadable
   processes do not prove exit; any unobserved/uncertain writer blocks capture.
   Approved Git/task creators can outlive their callers; wait for their actual
   completion/receipts rather than assuming cancellation on disconnect or exit.
   Include this maintenance conversation if it is itself an old managed writer;
   continue the operation from an independent human terminal. Do not edit live
   state to manufacture closure or bypass existing approval controls.
4. With all affected writers/consumers quiescent, capture all named roots
   coherently, including empty directories and SQLite sidecars, into private
   independent storage. Record the root mappings, current-file disambiguation,
   grouping facts and maintenance evidence in `source.json`. Mount the captured
   source read-only; ensure no nested writable mount or live alias remains. The
   platform-specific snapshot/mount actions need their own approved host scope.
5. Select the exact approved tool package without a system activation. For a
   reviewed local checkout, preparation is an isolated package build:

   ```sh
   nix build .#matrix-bridge --out-link /private/tool-root
   tool=/private/tool-root/bin/pi-bridge-migrate
   snapshot=/private/readonly-source
   bundle=/private/new-backup
   state=/private/new-bridge-state
   "$tool" inventory "$snapshot"
   "$tool" export "$snapshot" "$bundle"
   ```

   `/private/...` are placeholders to replace with owned private canonical paths.
   The backup and state destinations must be absent and outside every old root.
   Retain the inventory digest. Review failures before proceeding; export does
   not certify semantic completeness or Matrix accessibility.
6. Mount the independently exported bundle read-only, then:

   ```sh
   bundle_ro=/private/readonly-export
   "$tool" import "$bundle_ro" "$state"
   "$tool" check "$bundle_ro" "$state"
   ```

   Review `migration-report.json` and the complete inventory. Resolve or explicitly
   retain each missing/unfrozen/uncertain finding. Do not call an absent native
   file, incomplete grouping or inaccessible original room repaired. Check must
   show a pristine, not-started ledger and unchanged original native files for
   the pre-start rollback shortcut; this remains contingent on quiescence and
   separate human approval. Do not run the new daemon as a validation command.
7. Before any new writer/consumer starts, an approved rollback may restore the
   **complete** frozen old installation. Do not mix old/new files. After the first
   new writer starts, use receipt reconciliation (which may prove no new effects)
   or local-only continuation. After new native work/input/output, retain all new
   histories and receipts; restoring an old sync cursor/queue is unsupported.
   Absence of a response, timeout or startup failure does not prove no effects.
8. Only the later approved cutover changes host/account services and the new
   state-directory selection. Never overlap old/new bot consumers or native
   writers. Validate exact original-room ownership/accessibility and per-room
   delivery; verify imported disabled identities stay local-only, fresh sync
   fences hold, original sends deduplicate, and useful ordinary native/Pi/tmux
   workflows remain. Actual Matrix/phone/NAS/picker canaries belong to #172.
9. Keep frozen backup, original stores and old closures until the approved live
   acceptance is recorded. Their retention is not permission to run them beside
   the new authority. Cleanup of partial artifacts/backups is a separate explicit
   decision, never an automatic migration rollback.

## Crash-boundary matrix

| Boundary | Before / side effect | Durable identity | Interruption/retry | Evidence |
| --- | --- | --- | --- | --- |
| Quiesce/capture (human only) | Stop only approved old consumers/writers; coherent independent capture | Maintenance record, original root map, immutable source | Uncertain exit/incomplete capture blocks; no JSON repair or overlap | Runbook; production proof deferred to #172 |
| Source inventory/read | Only frozen read-only roots; no legacy loaders | Sorted paths/sizes/SHA-256 + descriptor | Writable mounts, aliases, special files and inconsistent evidence fail; source unchanged | Actual read-only fixture/rejection and byte comparison |
| Export copy | New private sibling; original bytes only | Inventory digest | Partial sibling retained; never a complete export | Exception + actual SIGKILL after file copy |
| Export marker | Copies/directories synced before marker | Complete inventory | Crash before marker cannot publish; retry uses a fresh sibling | Exception + SIGKILL before marker |
| Export publish | Complete staging synced; no-replace rename; parent fsync | Inventory digest | Lost result rechecks complete target; foreign/different target untouched | Before/after rename exception + SIGKILL; duplicate export |
| Convert | Decode frozen evidence only | Original native/room/event/transaction IDs | Missing/unknown/unfrozen evidence is blocked/reported, never invented | Corruption, missing, ambiguous, frozen/unfrozen fixtures |
| Import transaction | Fresh unpublished SQLite; bindings/delivery/media/policy/cutoffs together | One SQLite commit + source digest | Crash leaves only private staging; no partial destination | Before/after commit exception + actual SIGKILL |
| Import receipt | Closed/checkpointed DB synced; report/receipt synced | DB/report checksums + source digest | A partial sibling is not active state | Receipt-boundary SIGKILL; integrity/row checks |
| Import publish | Complete directory no-replace rename then parent fsync | Complete receipt | Duplicate import checks, never merges or resets newer data | Before/after rename SIGKILL; byte-identical repeated destinations |
| First runtime writer | New authority can begin | Permanent same-ledger started marker | Conservatively require receipt reconciliation; not an execution receipt | Runtime-open and new-work/repeated-import tests |
| Read-only check | No journal evidence; immutable SQLite URI | Existing checksums, native-byte observations | Reject journals/concurrent change; never create sidecars or repair | Packaged CLI and post-WAL-runtime regression |
| First sync/history | Original per-room gaps + conversion tail; old work held | Event IDs, input holds, projection cursor | No backfill/replay; disabled departed rooms cannot pin sync | Sync-gap/hold test; native private-start test |
| Original room proof | Exact imported receipt; current immutable creator/policy | Same-ledger verification receipt | Unknown/foreign original held, no replacement; grouping independent | Injected Matrix ownership/isolation tests |
| Output retry | Approved new daemon eventually retries frozen send | Original bot/room/type/transaction/content | Lost ACK retries identical bytes/ID | Injected HTTP test only; live receipt deferred to #172 |
