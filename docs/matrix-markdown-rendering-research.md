# Matrix bridge Markdown rendering investigation

Implementation follow-up: the Android-first managed renderer is now implemented
under [#122](https://github.com/BeaudanBrown/pi-harness/issues/122), not deployed.
See [design](matrix-android-rendering-plan.md) and
[verification/review outcomes](matrix-android-rendering-evidence.md). The current-
behavior analysis below records the original research baseline, not the new renderer.

## Summary

Matrix already supports substantially richer formatting than the managed-session
bridge emits. Improve ordinary Markdown blocks and code first, not arbitrary HTML.
Treat Element X compatibility and restart-safe projection as acceptance criteria.
This investigation changes no renderer or deployed service.

## Protocol capabilities

The [Matrix Client-Server specification](https://spec.matrix.org/latest/client-server-api/#mroommessage-msgtypes)
defines `org.matrix.custom.html`, not a Markdown wire format. Send a readable
plain-text `body` alongside HTML in `formatted_body` and the `format` field.
The server does not convert Markdown into HTML for the bot.

The spec recommends a restricted HTML vocabulary including headings, paragraphs,
blockquote, unordered/ordered lists, emphasis, strike-through, inline/preformatted
code, links, horizontal rules, basic tables, spans, images, details and summary.
It explicitly allows clients to support a subset and fall back to alternative
representations. Protocol permission is not a client conformance guarantee.

Useful permitted attributes include `ol start` and `code class="language-…"`.
Since v1.18, clients supporting ordered lists must also support `start`. Links
have a scheme allowlist; images must use `mxc://`, not remote HTTP image URLs.
Arbitrary CSS, event handlers, scripts and general HTML attributes are not part
of the recommended vocabulary. HTML nesting is limited to 100 levels.

[Spoilers](https://spec.matrix.org/latest/client-server-api/#spoiler-messages)
use `data-mx-spoiler`; mathematical content has its own
[representation](https://spec.matrix.org/latest/client-server-api/#mathematical-messages).
These are separate enhancements, not reasons to pass model-generated HTML through.

## What this repository currently does

### Managed engineering agent bridge

`config/agent/extensions/managed-sessions/relay/transcript-renderer.ts`:

- Recognizes only single-backtick code, simple `**bold**`, simple `*italic*`, and
  short `[label](URL)` links through one inline regex.
- Escapes raw HTML, and accepts only HTTPS URLs without username/password.
  This is deliberately stricter than Matrix; preserve it unless changing policy
  is explicitly desired.
- Wraps blank-line-delimited text in `<p>` and every remaining newline in `<br>`.
- Has no Markdown block parser: headings, fences, lists, quotes, rules and tables
  do not become their corresponding HTML blocks.
- Does not implement nested emphasis, escapes, reference links, multi-backtick
  code spans, underscore emphasis, strike-through, or balanced link destinations.
- Splits source text to fit both plain and rendered 8,000-byte limits, with a
  64-chunk ceiling. Splitting may occur inside a Markdown construct; each fragment
  is then independently parsed without continuation context.

`relay/matrix-client.ts` already sends `format`/`formatted_body`, so the transport
has the necessary capability. `relay/transcript-projector.ts` handles terminal
user turns and final assistant answers. `relay/event-projector.ts` reuses the
renderer for notices and text checkpoints; option-bearing question checkpoints
use the separate poll publisher instead.

`tests/managed-session-transcript-renderer.test.ts` covers basic escaping, unsafe
links, plain fallback, determinism and byte limits, but not block structures or
formatting across chunk boundaries.

### Separate stateless chat assistant

`config/agent/extensions/bridge-chat/transport.ts`, `Matrix.send`, sends only
`{ msgtype: "m.text", body: "Pi: " + text, "m.mentions": {} }`. It does not currently
use the managed renderer or send formatted HTML. This is a distinct improvement
surface, and bridged networks may have their own conversion limits.

## Client evidence and limits

Element X Android's own [issue #1551](https://github.com/element-hq/element-x-android/issues/1551)
reports table-cell content disappearing in version 0.2.3; the issue was open when
inspected. This is primary historical bug evidence, **not** verification that a
current installed release still behaves that way.

No current Element X device rendering was tested in this investigation. Do not
claim current iOS/Android table, disclosure, spoiler, math or syntax-highlighting
support from the protocol allowlist. A code language hint is useful even where
clients merely display monospaced code rather than highlight it.

### Follow-up: are clients expected to render tables?

**Element Web/Desktop: yes, basic received HTML tables are expected.** The
[current shared HTML sanitizer at revision
0046435](https://github.com/element-hq/element-web/blob/0046435cc8d54b22c16f14f6bfc5e29ac0944240/packages/shared-utils/src/html/sanitizeHtmlParams.ts)
explicitly permits `table`, `thead`, `caption`, `tbody`, `tr`, `th` and `td`.
[Element Desktop](https://github.com/element-hq/element-desktop) packages Element
Web. This supports basic table structure, not arbitrary styling or advanced
attributes, and is source evidence rather than a test of the installed release.
The current `apps/web/src/Linkify.ts` delegates sanitization to this shared
module; the allowlist is no longer defined directly in `Linkify.ts`.

**Element X iOS: no native table layout in the inspected renderer.** At revision
[e67a4c3, `AttributedStringBuilder.swift`](https://github.com/element-hq/element-x-ios/blob/e67a4c388fd8b50ebee51e83a02500dc20945c93/ElementX/Sources/Other/HTMLParsing/AttributedStringBuilder.swift),
the HTML tag switch implements headings, lists, quotes, code and other formatting,
but has no table/row/cell cases. Its default recursively appends child content.
Table text can therefore survive without columns or table-specific row/cell
separators; this is not a structured table renderer.

**Element X Android: do not expect structured table layout.** Historical issue
#1551 reports lost contents in the old rendering path. The repository still
contains a `StyledHtmlConverter`-based provider, and a newer HTML-renderer module.
At revision
[2dd0a47, `DefaultHtmlMessageParser.kt`](https://github.com/element-hq/element-x-android/blob/2dd0a47eb4c8dbccb4ccac29e41a5a57aaee2a5e/libraries/htmlrenderer/impl/src/main/kotlin/io/element/android/libraries/htmlrenderer/impl/DefaultHtmlMessageParser.kt),
the newer parser has code, quote, list, heading and paragraph nodes, but no table
nodes. Unknown inline wrappers recurse into their children, explicitly retaining
text. Thus it is too strong to say all current Android rendering necessarily
loses table text: the newer parser preserves unsupported-wrapper content, but
still does not implement table layout. Which path the installed version uses
was not verified.

**Our bridge fails earlier than either client:** the managed renderer never
converts pipe-table Markdown into `<table>` HTML. It sends escaped text inside
paragraphs with line breaks. Consequently even a table-capable Desktop client
cannot display those bridge messages as real tables. Raw model-generated HTML
is also escaped. A correct HTML table from another sender and a Markdown pipe
table from this bridge exercise different capabilities.

### Follow-up: collapsible sections and inline images on Android

Matrix permits `details`/`summary` and `img` with `mxc://` sources, but the
inspected Android `DefaultHtmlMessageParser.kt` implements neither disclosure
widgets nor inline images. Unknown wrappers recurse into children, so details
content may appear as ordinary text rather than a collapsible section. An `img`
has no child text, so that fallback does not provide an image or even its alt
attribute. The historical [inline-image issue #1874](https://github.com/element-hq/element-x-android/issues/1874)
also reports blank rendering of an HTML `img` in a text event.

These are not dependable features for an Android-first bridge. This finding
concerns the inspected newer parser, not a live test of every released Android
rendering path. Native `m.image` attachments are a different supported media
mechanism; use the existing artifact-export path for images rather than embedding
HTML images. Do not generalize Android disclosure limitations to iOS: the
inspected iOS builder explicitly handles `details` and extracts its summary.

Basic Markdown block rendering is a bounded improvement, but full parsing,
context-preserving byte-limited chunking and compatibility for partially sent
projections make the complete change more than a quick regex patch.

The practical choice remains: add actual HTML tables for Desktop/Web-oriented
output, or use explicit row-oriented text/list formatting for consistent Element
X output. A plain fallback alone cannot force mobile clients to choose it over
unsupported HTML.

For mobile-first output, make tables readable without depending on native table
layout: consider row-oriented lists or preformatted compact text. Merely improving
`body` does not guarantee recovery on a client which chooses the HTML version
and then drops unsupported content.

## Recommended bounded improvement

1. Use a small pinned Markdown parser rather than extending the regex into a
   home-grown CommonMark parser. Evaluate a CommonMark parser with GFM tables and
   strike-through support; dependency availability/packaging must be checked.
2. Render tokens through a Matrix-specific, allowlisted renderer. Disable raw
   HTML, escape all text/code, retain the existing HTTPS-only link policy, and
   do not introduce automatic external images or media uploads. Task checkboxes
   should become text, not unsupported HTML inputs.
3. Prioritize fenced/indented code, headings, ordered/unordered and nested lists,
   blockquotes, rules, nested inline formatting, and strike-through. Keep code
   contents literal; do not parse Markdown inside code. Validate language hints
   before emitting `language-*` attributes.
4. Parse the entire source before splitting. Split on block boundaries where
   possible; reopen/close code and list containers for oversized blocks so every
   event has valid HTML and meaningful continuation. Preserve ordered-list
   numbering and all original fallback content across chunks.
5. Retain bounds on both encoded bodies, deterministic output, the maximum chunk
   count, source attribution, and non-projectable transcript filtering.
6. Consider sharing the safe rendering module with stateless chat only as a
   separate integration; preserve its existing prefix, mention behavior and
   stable transaction/retry semantics. Test actual bridged delivery separately.
7. Defer math, spoilers, details/summary and rich inline images until needed and
   verified in the operator's actual clients. Spoilers especially require a
   non-revealing plain fallback; raw Markdown currently preserves source text.

## Critical upgrade/recovery constraint

This is not only a cosmetic function replacement.
`relay/transcript-projector.ts` and `relay/event-projector.ts` recompute rendering
before resuming persisted projections. Registry projection records store source
hashes and chunk/transaction metadata, rather than frozen rendered bodies.
`RelayRegistry.beginProjection` rejects conflicting chunk plans. Source hashes
and transaction IDs do not identify a renderer version.

A new renderer can change the number or contents of chunks for unchanged source.
A changed chunk count can fail recovery; unchanged count but changed boundaries
can combine already-sent old chunks with new chunks, losing or repeating text.
Even ordinary output growth can change existing split boundaries.

An implementation must choose an explicit compatibility strategy: keep a legacy
rendering path for old projections, or durably freeze versioned rendered payloads
before sending and migrate old records safely. Do not merely deploy a new parser
against pending old transactions. See
[ADR 0002](architecture/decisions/0002-managed-session-contracts.md) for stable
projection identity and deterministic chunk requirements.

## Acceptance evidence for a later implementation

- Golden fixtures for each supported block/inline feature and literal code.
- Hostile HTML, attributes, malformed links and encoded unsafe schemes.
- Unicode and escape-heavy byte-limit fixtures for plain and formatted bodies.
- Oversized fences/lists/paragraphs: complete content, valid per-event HTML,
  stable chunking, correct continued numbering and no silent truncation.
- Partial-send restart with old and new renderer versions: no duplication,
  omission, transaction-body replacement or chunk-plan mismatch.
- Existing transcript, event/checkpoint, Matrix-client and registry tests, then
  the canonical deterministic gate `nix run .#verify` for production changes.
- A disposable-room fixture viewed on the operator's actual Element X version
  and Element Web. For stateless chat, also inspect the bridged destination.

No live messages, builds, implementation tests or deployment were performed.
