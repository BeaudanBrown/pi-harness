# Android-first managed Matrix rendering proposal

Status: implemented under [issue #122](https://github.com/BeaudanBrown/pi-harness/issues/122),
not deployed. GitHub remains the task source of truth. Original design and
acceptance plan below; actual outcomes are in
[implementation evidence](matrix-android-rendering-evidence.md).
Research: [rendering research](matrix-markdown-rendering-research.md).

## Objective and scope

Improve messages from the managed engineering-agent bridge for Element X Android,
without relying on native table layout or unsupported interactive HTML.
Applies to final answers, labelled terminal-user transcript turns, text
checkpoints and notices. Keep option-bearing checkpoint polls unchanged.
The separate stateless `!pi` assistant is out of scope.

Source support was inspected on Android development revision `2dd0a47`; the
installed client version must be checked before release. Do not promise syntax
highlighting, heading-size parity or rendering-path equivalence from source alone.

## Output contract

| Markdown input | Output |
| --- | --- |
| Paragraphs and explicit line breaks | `p` / `br`; preserve meaningful line breaks |
| Headings | `h1`–`h6` |
| Bullet/numbered lists, including nesting | `ul` / `ol` / `li`; preserve non-1 starting numbers |
| Blockquotes | `blockquote` |
| Fenced and indented code | `pre` with literal escaped code; do not interpret Markdown within it |
| Inline code, including multiple backticks | `code` |
| Bold/italic, including nesting | `strong` / `em` |
| Strike-through | `del` |
| Links and reference links | `a`; existing credential-free HTTPS-only policy |
| GFM pipe tables | Row-oriented paragraphs and lists; never `table` |
| Task lists | Text markers `[x]` / `[ ]` inside ordinary list items |
| Horizontal rules | Visible text separator; do not depend on unsupported `hr` |
| Raw HTML | Literal escaped text, never passed through |
| Markdown images | Readable image label/link where safe; no inline image or automatic fetch/upload |

For tables, label each nonempty cell with its column heading. A row such as
`Fast | Higher | Lower` under `Option | Cost | Latency` becomes:

**Row 1**
- **Option:** Fast
- **Cost:** Higher
- **Latency:** Lower

Use row numbers rather than guessing which column is a title/key. Preserve
empty cells explicitly, repeated headings and inline formatting. Use
`Column N` for missing/empty headings. Discard layout/alignment metadata, not
cell contents. Split oversized rows between cells or within a cell as necessary.

Exclude interactive spoilers, `details`/`summary`, maths rendering, colours,
inline images and native HTML tables. Separate image attachments continue using
the existing explicit artifact-export tool.

## Design

Use `markdown-it` with raw HTML disabled, default table/strike-through support,
no automatic linkification, and no typographic rewriting. Pin it and its runtime
dependencies explicitly through Nix; do not depend on accidental upstream Pi
transitive dependencies. Packaging feasibility is a pre-implementation check;
if the dependency cannot be supplied cleanly, resolve the parser choice before
continuing rather than inventing a new regex parser.

Introduce a small pure rendering module with one public operation:
`renderTranscript(kind, source) -> bounded chunks`. Keep parsing, Android table
lowering and serialization internal. Retain existing caller interfaces where
possible. Each result contains readable fallback text and restricted HTML.

Parse the full source once; lower tables into supported blocks before splitting.
Keep original Markdown in the plain fallback where practical, including table
cell text, but do not require fallback chunks to correspond to source slices.
Their concatenated content must retain all meaningful source content. Raw HTML
remains visible text. Safe-link rejection remains explicit. Images must not
silently disappear. No content is silently truncated.

Prefer whole blocks per chunk. Oversized blocks split at text/token boundaries,
not arbitrary HTML offsets. Reopen containers in each event, close them within
that event, preserve code whitespace and ordered-list offsets. Every chunk is
valid standalone HTML. Enforce the existing 8,000-byte budget independently for
both fields, including local-user prefixes and HTML container overhead, and
retain the 64-chunk ceiling. Exceeding capacity fails explicitly.

## Recovery compatibility: implement before switching renderers

Retain the current renderer unchanged as legacy v1. Add an explicit rendering
version to new durable projection records, plus frozen plain/HTML chunk payloads
for new v2 projections. Older records without a rendering version remain legacy
v1 and use the original renderer and chunk plan. Do not reinterpret old source
using v2, including fully sent entries offered again after reconnect.

For a new projection, persist the selected version, complete bounded chunk plan,
and exact payloads before the first Matrix send. Retries use those frozen bytes
with existing transaction IDs. Verify source identity/hash on repeat offers and
reject conflicts. Keep checkpoint/poll source identity separate; no change to
transaction derivation or poll semantics.

This requires coordinated changes to contracts/schema validation, registry,
transcript and event projectors, and restart tests. Budget frozen payload storage
under existing projection retention limits; validate both per-chunk and total
bounds on load. Update the restart-safe-update compatibility documentation and
explicitly reject unsupported downgrade rather than silently discarding fields.
Do not unconditionally recompute v2 output before looking up an old projection.

Crash cases to prove:

- Before durable projection: retry can prepare one deterministic plan.
- After durable projection, before send: retry sends frozen pending chunks.
- After Matrix acceptance, before recording sent: retry the same bytes/txn ID.
- After a partial v1 send, upgrade: finish using v1, not v2 boundaries.
- After a partial v2 send, later renderer change: finish frozen payloads.
- Fully sent old entry offered again: no new sends or chunk-plan conflicts.

## Delivery slices and acceptance evidence

1. **Compatibility foundation.** Keep current visible rendering; add versioned
   frozen projections and the legacy path. Prove all crash cases above for
   transcript turns and text checkpoint/notice projections. Polls unchanged.
2. **Android renderer and packaging.** Add pinned parser, pure renderer, table
   lowering and block-aware splitting. Golden fixtures cover every output-contract
   row, nesting, malformed Markdown, literal code and unsafe links/HTML. Verify
   Unicode, escaping expansion, oversized code/lists/tables, attribution overhead,
   retained cell/text content, deterministic output and both byte bounds.
3. **Integration and release verification.** Switch only new managed projections
   to v2. Verify text checkpoints still fit a single event or fail explicitly,
   and increased formatting overhead cannot silently omit their content.
   Run affected schema/registry/projector/adapter tests and packaged relay probes.
   Run both Standards/Spec review axes over the complete cumulative change,
   remediate together, then `nix run .#verify` and the affected relay production
   build. Update the runbook and rendering research with actual outcomes.

Live acceptance is a separate deployment boundary: obtain approval, record the
operator's Element X Android version, and send one bounded fixture set to a
disposable room covering lists, code, headings, links, quotes, a lowered table
and a continued code/list block. Confirm text retention, copyable code and
readable numbering on the actual phone. No implementation slice needs Matrix
credentials. No client upgrade, service replacement, push or live message is
implicit in this plan.
