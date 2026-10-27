# Managed client acceptance (#121)

Status: Element X progress silence, final delivery and tap-through passed with
operator observation. Human denial and separate approval passed. Prompt readability
FAILED (raw JSON) and was explicitly deferred by the operator. Isolated services
are stopped and temporary credentials removed. Desktop checks remain outstanding.
Not a deployment or epic completion.

## Authorization and isolation

After the completed [behavioral acceptance](managed-live-behavior-evidence.md),
the operator approved isolated services and a few synthetic real-model replies
for phone notification and approval UX checks. Production remains untouched.
Dedicated owner/bot accounts and the original `isolated-smoke` host are reused;
previous behavioral conversations remain retired. Existing manual notification
preferences must not be reset to make tests pass.

## Observations and current phase

- Operator, using Element X: host → project → checkout → conversation hierarchy
  visible; original `project` room opens without access/encryption errors.
- Fresh disposable `elementx-v1` checkout and `Element X acceptance` conversation
  created through public host control. Original coordinator/sample preserved.
- Conversation: `conv_f5978d4f1c6d1a677bb74a61422be476`.
- Native persisted model selection confirmed `openai-codex/gpt-6.1-sol`.
- Operator selected existing ntfy for the test login and backgrounded Element X.
  Read-only pusher inspection confirmed `ntfy.bepis.lol` gateway and matching
  endpoint (no keys retained). No server configuration changes.
- One synthetic real-model turn sent after 20 seconds' grace. Matrix received
  `PROGRESS: checking the disposable test file.` with silent/no-room-mention
  metadata, and `FINAL: Element X notification test complete.` with notify/room
  mention metadata. Operator observed a single FINAL notification, but was not
  watching throughout: final delivery passes, commentary silence is unconfirmed.
  Tapping opened the correct conversation with both messages visible (PASS).
  Closely spaced events cannot rule out notification coalescing on the phone.
  Evidence: `.pi/tmp/workers/2026-10-27T12-06-56-369Z-elementx-background-notification-turn-d0b9692e76f8/`.
- Supervisor is bounded to 1,200 seconds, with cleanup of owned processes and
  temporary selected-provider/Matrix credential copies on exit. Startup ready
  is not evidence that final cleanup has occurred.

Startup command: the bounded Python launcher recorded in
`.pi/tmp/workers/2026-10-27T11-56-10-932Z-elementx-isolated-services-start-8215cbf80889/`
starts `.pi/tmp/live-elementx-services.py` and waits for its private ready marker.
The supervisor processes explicitly queued prompts only, with durable per-action
receipts; interrupted/uncertain actions are not replayed automatically. Source
and state are intentionally local test artifacts, not a fresh-state recipe.

## Remaining acceptance

1. Readable approval presentation (explicitly deferred; functional votes passed).
2. Desktop notification/navigation checks, separately observed.
3. Any further cleanup; retain uncertain intents and test rooms.

## Progress-only repeat and cleanup

Operator requested a repeat. A new, explicitly journalled real-model request
asked for commentary only, without a final. The first observation incorrectly
started its 30-second window at the Working placeholder, not actual commentary;
it failed validation. A further 80-second read-only observation found no expected
progress message. No silent-delivery pass is inferred and no prompt was replayed.

- `.pi/tmp/workers/2026-10-27T12-10-52-612Z-elementx-progress-only-notification-ec419ada616e/`
- `.pi/tmp/workers/2026-10-27T12-12-03-828Z-elementx-progress-existing-turn-settlement-a1b2228d03a5/`

The attempt was cancelled through `!abort`, then the supervisor stopped. Owned
processes stopped, temporary model/owner credentials were removed, and the new
conversation/checkout/history remain for deliberate continuation:
`.pi/tmp/workers/2026-10-27T12-14-34-346Z-elementx-progress-attempt-cancel-cleanup-2d1d312684d7/`.
Its service cleanup PASS is not a progress-notification PASS.

## Controlled-gap retry

Operator explicitly requested another test. The same conversation resumed with
an additional disposable project extension delaying README reads by 60 seconds;
no production extension, policy or notification settings changed. After a
30-second phone-background grace, one new normal model turn generated progress,
read README, then generated final. Actual Matrix event timestamps were **61.948
seconds apart**, with silent/no-mention progress and notify/room-mention final.
Operator confirmed: “Progress stayed quiet; final alerted me.” Background
commentary silence and final notification therefore PASS for this observed
Element X/ntfy trial. The separation eliminates the previous near-simultaneous
final as a confounder without directly injecting synthetic bot events.

The first compiler invocation used a missing local executable and stopped before
services or input. Using the installed Nix `tsc` and project SDK/type declarations
passed (standalone /tmp LSP could not resolve dependencies). Actual commands:

```sh
tsc -p .pi/tmp/elementx-delay-tsconfig.json --noEmit
python3 .pi/tmp/live-elementx-gap.py
```

Evidence:
`.pi/tmp/workers/2026-10-27T12-18-33-817Z-elementx-separated-progress-final-live-1b81efb57c2b/`.
Owned services/native tmux stopped and temporary credentials removed. Original
rooms, identities, history and the client-test room remain; no new room created.

## Human approval UI phase

Operator agreed to the approve/deny UI checks. Bounded services resumed the same
client conversation and sent one real-model `conversation.create` request with
creation key `elementx-deny-v1`, title `Phone denial test`, confined to the
existing disposable `elementx-v1` checkout. A real approval poll appeared and
inventory remained unchanged before consent. No scripted vote was sent. The
operator chose Deny and observed `PHONE_DENIAL_COMPLETE`. Native tool evidence
returned `denied` / `Denied by operator`; public inventory still contained exactly
the same three conversations. No creation occurred (PASS).

However, the operator reported the poll shows raw action/data JSON and is hard
to read. Prompt readability FAILS client acceptance. Inspection confirms
`hostApprovalQuestion` in `relay/host-approval-prompts.ts` serializes generic
mutations as JSON. A readable action/effect/target summary must retain precise
frozen consent scope; backend denial success does not resolve this UX failure.
No approval request was sent. The bounded supervisor was asked to stop after
verification; final process/credential cleanup is checked separately.

Startup: `.pi/tmp/live-elementx-approvals.py`, via bounded launcher recorded in
`.pi/tmp/workers/2026-10-27T12-23-55-932Z-elementx-human-denial-prompt-start-4e6e88a9fa16/`.

### Explicit presentation deferral and separate approval

The operator chose “Continue testing functionality; defer presentation.” This
retains the readability finding; it does not waive or satisfy prompt UX acceptance.
After verified cleanup of the denial run, a new bounded supervisor resumed the
same source conversation and requested `conversation.create` with the distinct
creation key `elementx-approve-v1`, title `Phone approval test`, same disposable
checkout. A fresh poll appeared; inventory remained the same three conversations
before consent. No scripted vote was sent.

The operator approved in Element X and observed both `PHONE_APPROVAL_COMPLETE`
and the new conversation. Native tool evidence returned success with
`conv_d881edd49c78618dbe51367834b9c445`; public inventory verified exactly one new
conversation, ready and attached in the intended checkout, with all three
previous conversations preserved. The earlier typed denial remains in native
history. Functional human approve/deny therefore PASS independently of the
explicitly deferred presentation failure.

Safe verification record: `.pi/tmp/elementx-human-approval-result.json`. The
supervisor was then stopped; model/owner credential copies were absent and no
private tmux listener remained (stale socket removed only after ECONNREFUSED and
ownership/inode checks). Test rooms/histories are retained, not retired here.

Startup: `.pi/tmp/live-elementx-approve.py`, via bounded launcher recorded in
`.pi/tmp/workers/2026-10-27T12-29-02-458Z-elementx-human-approve-prompt-start-7807e1fc1a49/`.

Observed progress silence, final push delivery and tap-through are accepted for
this Element X/ntfy configuration, along with functional human approve/deny.
Readable approval presentation and desktop results remain outstanding. No publication, fleet
lock/evaluation, activation or migration is claimed.
