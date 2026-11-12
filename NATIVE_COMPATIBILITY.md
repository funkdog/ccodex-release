# Native Compatibility Boundary

## Ownership

- Enhanced Desktop uses the core shipped with its selected, immutable official
  package snapshot. Stock Desktop keeps its own registered package. Never set
  `CODEX_CLI_PATH` to the independently patched CLI when activating Desktop.
- The custom CLI selects only versioned, patched cores that retain its terminal
  features. It never self-updates into an ordinary stock core.
- Desktop owns native runtime manifests, plugin materialization and native pipe
  identity. A pipe from an arbitrary running Desktop instance is never selected.
- Stock configuration seeds a new profile. Repairs preserve the current
  configuration instead of copying stale stock runtime or authorization settings.
- The Ultra picker visibility setting is a first-run default, not an enforced
  migration value. Repairs preserve an explicit true or false preference.
- Native account entitlements and website challenges are not bridge features.
  The bridge must not impersonate native account authentication or suppress checks.

## Independent Desktop Updates

The enhanced launcher binds a private snapshot, profile, listener owner and
process lifetime. It never borrows the stock window or an arbitrary debugger
port. Model selection, the Effort slider and their native animations stay
mounted; the renderer extension adds Context without substituting those controls.

The account panel includes private Desktop update controls. Supported native
renderer update buttons route to that panel, using an owner-guarded binding.
This does not intercept the native operating-system application menu or prove
that every future updater contract is compatible.

Use `ccodex desktop update check`, `prepare`, `validate <candidate>` and
`apply <validation.json>` for the same private update backend. Check reads
official download metadata, not a verified latest version. Prepare verifies
the official package and creates a candidate without selecting it. Apply
requires validation bound to the current extension source, native UI and
Context adapter. Failed checks preserve the previous selection; a successful
selection takes effect when the enhanced instance is normally restarted.
No update job installs or updates the stock Desktop package.

The asynchronous UI service journals failures, coalesces repeated clicks and
preserves live worker locks after a helper exits. Native renderer acceptance
is still required; fixture results are never promoted to that evidence.

## Update Recovery

`ccodex update check` queries only the official stable Codex release metadata,
without sending Copilot credentials. `status` is offline. A newer upstream
version is not evidence that a compatible enhanced core exists.

`ccodex update prepare <verified-release-directory>` checks the actual target
executable, complete native patch provenance and a matching
`cli-update-compatibility.json` runtime receipt. Every native enhancement must
be validated against the exact current extension source. Preparation is inert.
`ccodex update apply <candidate-id>` rechecks the prepared executable, source
generation and previous selection, then atomically changes only the private CLI
pointer. Existing CLI processes and Desktop snapshot selection are untouched.
Unix uses per-user core slots even when the installed package is system-owned.
Core preparation and promotion use the same global heavy-task scheduler as
installation, serializing updates instead of racing independent writers.

The compatibility receipt is not synthesized from fixture tests or from an
official version number. Until real migration/runtime evidence is available,
candidate preparation fails explicitly and preserves the installed enhanced
core. This offline candidate path does not yet provide an online enhanced
release feed or prove that the upstream migration has been completed.

`tools/native-runtime.mjs` validates complete runtime manifests, repairs missing
browser files only from the same-version local Desktop bundle, and aligns the
managed marketplace source with the active profile's Desktop staging location.
It preserves disabled plugins, custom MCP servers and native security settings.

The Windows CLI preflight installs `bridge/native-mcp-relay.mjs` around the
official MCP host. The relay re-reads the profile's authoritative native settings
between calls. If the Desktop runtime changes, it closes and initializes the
official host, reports that JS bindings were reset, and does NOT execute or
replay the pending action. The caller must initialize again and observe fresh
state. Cancellation and turn-ended cleanup still reach the previous host.
Discovery-triggered reconnections also invalidate the next stateful call.
Bidirectional MCP request IDs remain independent, including user authorization.
Missing-file recovery validates both source and destination trees before copying
and refuses directory junctions that could redirect writes outside the cache.

Already-running clients created before this repair need an MCP reload or a new
CLI session once. JavaScript kernel reset alone cannot replace the old MCP
process environment.

The Desktop helper uses a shared, deadline-bound CDP connection. Disconnects,
timeouts and renderer resets settle all pending commands and remove listeners.
An initialization deadline also closes the transport; it does not leave a
second account binding behind. Late close callbacks cannot remove a replacement
session, disappeared targets are pruned, and normal helper exit closes all
retained connections. Requests are not replayed after an ambiguous failure.
These transport changes do not broaden native authorization. Existing
version-sensitive renderer feature hooks still fail explicitly if their
signature changes; they are not a guarantee of future upstream compatibility.

## Responses Stream Identity

The native Responses provider can rotate opaque item IDs between `added`,
each delta, `done`, and `response.completed.output`. Forwarding those IDs
unchanged gives the native core separate start/completion identities and leaves
duplicate live messages even when saved history contains only one item.

`bridge/response-identity.mjs` assigns one display identity per response and
`output_index`, independent of text, model name, provider ID format, or Desktop
version. `bridge/responses-stream.mjs` applies it to streamed item references.
Content, call IDs, encrypted reasoning, metadata, future payload fields,
terminal errors, and genuine repeated messages are not deduplicated or hidden.
The stream still publishes initial deltas before completion and respects
backpressure and client cancellation. Once streaming starts it is not replayed.

Opaque provider IDs are not discarded or assumed interchangeable. Their
authoritative values are committed atomically before publishing local IDs and
restored on later requests, including after a bridge restart. The versioned
`response-identities` directory belongs to the profile, not a disposable cache.
Preserve it when backing up or migrating conversations that contain bridge item
IDs. It contains identity mappings, not prompts, responses, tools or tokens.
Records are scoped to the upstream provider and account. Missing, invalid,
foreign-account, or unsupported identities fail explicitly before an upstream
request instead of guessing a replacement. Normal non-bridge IDs are untouched.
The transfer bundle intentionally exports neither sessions nor profile data.

The bridge publishes its startup source generation and identity capability in
`/health`. The launcher compares that generation with the installed source tree
and refuses to silently reuse an older process. Deployment separately records
whether running-process activation is still required; matching files on disk
are not proof that the live bridge loaded them. Neither check stops a running
task. An existing busy bridge must be left alone until a safe service restart.

## Responses Upstream Transport

Streaming full-history requests prefer WebSocket only when the selected model
advertises `ws:/responses`. `bridge/upstream-responses.mjs` changes only the
`response.create` envelope and omits the HTTP `stream` field. Input, encrypted
reasoning, selected effort, tools, call IDs and future request fields are retained.
HTTP-only models, non-streaming or explicit background requests and prior-response
ID continuations keep their existing HTTP contract.

There is no inference-duration deadline or reasoning checkpoint. A bounded
handshake may fall back to the unchanged HTTP request only before any inference
has been sent. An active WebSocket is never silently replayed through HTTP.
Its genuine events use the existing identity, SSE framing, keepalive, context
error and cancellation pipeline. Queue overflow and incomplete EOF are explicit
failures, not trimming, invented completion or zero-token usage.
Upgrade request/quota headers are observed through the per-socket dispatcher,
without changing the shared dispatcher or authentication headers. Audits expose
`upstreamTransport`, `upstreamHandshakeHttpStatus` and `upstreamTransportFallback`;
the health capability is `responsesUpstreamWebSocket = 1`.

Actual downstream cancellation releases the socket and blocked reader. A native
client's logical interrupt does not necessarily close its HTTP reader immediately:
the pinned CLI's quiet reader waits for its next provider event in both the old
HTTP path and the new WebSocket path. Isolated native regressions compare that
behavior instead of forcing it with fabricated model events or a bridge deadline.
Provider connection limits and real errors remain visible; transport selection
is not a promise that a service can never disconnect.

## Verification

Run `tools/Test-NativeRepair.ps1` through the machine's heavy-build wrapper.
Use `-AllTests`, the exact Desktop `-NativeCore`, the installed CLI pointer's
`-CliCore`, and the pinned SDK `-DependencyProfile` for the full gate. All three
runtime inputs are mandatory for a deployable run. The gate records TAP counts
and rejects failures, cancellations, skips, TODOs or absent summary counts.
Deployment independently rejects incomplete runtime-coverage evidence before
touching installed files. For a non-deployable focused run, omitting `-CliCore`
uses the native core for both clients and does not establish cross-version
compatibility.
`-TestFiles` selects a focused, non-deployable run and cannot be combined with
`-AllTests`.
`-TestConcurrency` may reduce test-runner parallelism from six down to one for
Windows process-startup timing tests. The machine-wide heavy-task lock,
BelowNormal priority, maximum of six, full runtime coverage and zero-skip gate
still apply; reducing resource pressure does not permit skipping tests.
Tests use temporary profiles, mock cloud
data, actual native app-server protocol round trips, and checked process cleanup.
On Windows, the nine explicitly declared Unix-only checks are executed again on
the actual WSL platform. The shared coverage validator requires a named passing
Unix result for every Windows skip, retains both original TAP summaries, and
aggregates only executed tests. Unknown skips, absent summaries, failed tests or
missing native runtime inputs remain deployment failures. The WSL process
lifetime is tracked separately; covering platform-specific tests does not
substitute for six-target native core or Desktop UI acceptance.
The deployment gate verifies the hashes of every file in
`tools/native-repair-files.json` and every shipped bridge/tool code dependency;
editing or adding a repair dependency requires a new test run. Test and
deployment use the same complete inventory, rather than copying a server
without its newly imported modules.
This prevents stale passing evidence from authorizing an untested deployment.
Response identity caches remain account/provider scoped. When a resumed request
already carries a complete message, reasoning or tool item but its reversible
display-ID record is unavailable, the Responses bridge can replay that exact
caller-supplied item without the bridge-only `id`. Content, encrypted reasoning,
call IDs, arguments, outputs, phases and future fields are not removed or
rewritten. No opaque identifier or cached content is imported from another
account. Recovery is recorded as a bounded diagnostic and response header.
Unmaterialized item references, malformed aliases, unreadable storage and
corrupt records still fail explicitly before any upstream request. This does
not edit the saved conversation, fabricate a summary or retry a published turn.
Mock-transport tests cover handshake/command/installation failures, concurrent
waiters, renderer reset, account-fetch cancellation, protocol errors and target
replacement. They never connect to or automate the live Codex UI.
The independent model controls also have isolated renderer regressions for
committed versus alternate React trees, per-conversation menu ownership,
delayed and rejected callbacks, native disabled controls and keyboard focus.
The renderer adapter follows committed child links from the current HostRoot;
an unknown shape leaves the native picker usable. These isolated regressions
are not a claim that a running Desktop has loaded newly installed code.

`tests/live-keyboard-smoke.cjs` exercises candidate Shift+Enter through native
Windows records and record-delivered CSI-u, without the optional nested PTY
proxy. `tests/live-context-status-smoke.cjs` uses an isolated loopback provider
to check successful and failed compactions, persisted resume counts, account
changes and per-bucket quota expiry through the actual candidate TUI. Neither
test uses real account credentials or sends external model requests.
Windows status tests start the native core within a checked-in same-console
parent probe. They compare every inherited input-mode flag after graceful exit,
then require the unrepaired parent to read plain Enter normally. Both initially
enabled and disabled VT-input modes are covered by the standalone recovery
smoke. ConPTY consumes Win32 keyboard mode resets, so captured `?9001l` text is
not used as evidence of parent recovery.
Process evidence includes creation times so a reused Windows PID is not
misidentified as a surviving test child. Ancestry is also checked against each
parent's creation and observed exit/replacement bounds; ParentProcessId alone
does not establish ownership. Separate lifetimes sharing a PID retain separate
records. Cleanup records every tracked lifetime before reporting failure, keeps
TAP counts, and preserves temporary profiles when a tracked child remains.
Deployment requires the explicit process-lifetime cleanup attestation.

The transcript tests retain real repeated messages while asserting that paired
legacy records render as one item per message and that live canonical item IDs
remain unchanged through history hydration and resume.
They also reproduce the reported paginated format: a canonical `item_completed`
message followed by the same wire message with an unrelated ID. The isolated
rollout is opened to materialize its native index; both item and full-turn
pagination must return one item per genuine message. A raw copied rollout
without that native index is not a valid pagination fixture.
An independent-client test holds a synthetic turn open while the other core
reads its persisted items, then compares message identities after completion,
turn pagination and reconnection. This adds coverage for CLI-to-Desktop history
sharing, but still does not constitute visual renderer acceptance.
Its initial wait allows managed session-start checks to finish before model
inference. These checks remain enabled. A timeout records local mock transport,
core notifications and stderr so startup delays cannot be mislabeled as a
history or rendering defect.

The rotating-ID regressions check actual `item/started`, every delta,
`item/completed`, saved history and a second turn after restarting the isolated
bridge on both Desktop and CLI cores. Restored request IDs must match the
provider's final IDs exactly. Synthetic stream tests disable unrelated app and
plugin discovery only in their temporary profiles; they never alter production
features or native permission settings. A profile is not deleted while its
test core is still running.
The pinned native safety-retry fixtures also disable unrelated app and plugin
discovery in both their temporary file config and initial in-process config.
This prevents marketplace synchronization from competing with their loopback
turns or outliving the fixture. Their five-second event deadlines and retry,
draft, steer and goal-preservation assertions are unchanged.

`tools/Probe-ResponsesIdentity.mjs --profile <authorized-profile> --model <model>
--report-directory <evidence>` is an opt-in, synthetic no-tool provider probe.
`--verify-normalization` also checks stable downstream IDs, exact restoration
of all provider item fields, and a real follow-up request. It reads only the
selected saved credential, uses an isolated temporary profile, records identity
fingerprints instead of response bodies or credentials, and never falls back to
another account. Run it through the heavy-build wrapper as well.
`--verify-normalization --verify-materialized-recovery` additionally removes
only the probe's own temporary identity cache and checks that the real provider
accepts a synthetic follow-up with complete non-identity fields preserved.

`tools/Test-NativeChannel.mjs` is an optional read-only native smoke test.
It never approves elicitation or changes app permissions. A request for user
authorization is recorded as a limitation, not passed off as successful capture.

These checks address the diagnosed coupling and stale-state failures. They do
not guarantee that arbitrary future upstream changes or service restrictions
can never cause a regression. A new unsupported contract must fail explicitly,
retain evidence, and be validated before being advertised as compatible.

### CLI Update Receipts

`tools/write-cli-update-compatibility.mjs` binds the complete isolated package,
native Context, keyboard, parent-console, compaction/resume, attachment and
streaming checks to the exact executable, patch tree and current extension
source. A version-only launch or parser fixture cannot produce this receipt.
Forced fixture cleanup is a failed compatibility check, not graceful recovery.

Every target package includes `cli-update-compatibility.json` beside its core.
Both packaging and archive verification reject absent or stale receipts.
`ccodex update prepare` checks the same bound evidence before creating an
immutable private candidate, and `apply` rechecks it before switching only the
enhanced CLI pointer. Existing sessions, the stock CLI and the Desktop snapshot
selection are not replaced by a CLI update.

These tools provide a validation and promotion path; their presence is not
evidence that a particular release or installation has passed it.

## Native Context Recovery

The bridge does not own conversation compaction. Codex still chooses its
per-model threshold, creates the summary, persists the resulting history and
reports successful compactions. Copilot may label an actual context-window
overflow as the generic `invalid_request_body`. The bridge recognizes only
explicit context codes or matching overflow messages and exposes the native
`context_length_exceeded` Responses failure protocol. An ordinary invalid
request is not converted into a context error.

Streaming HTTP context failures use a failed Responses event rather than a bare
HTTP 400: native Codex otherwise classifies that HTTP response as an invalid
request and cannot update its context-full state. This applies both to native
Responses models and models using the Chat Completions adapter. Provider error
fields and genuine partial output are preserved. Failed compaction inputs can
then be reduced by the native algorithm, not by a bridge-generated summary or
silent history deletion.

HTTP 408 is a transport timeout, not evidence that context is full. Retrying it
does not truncate historical tool outputs, replace a native compacted window,
or ask the user to discard a conversation. Input bytes are diagnostic only.
Profile repair, CLI initialization and model/Context selection preserve native
`model_context_window`, `model_auto_compact_token_limit` and `compact_prompt`;
the native core owns their validation and per-model limits. An unspecified
effort retains the current effort when the selected model supports it.

Both wire formats propagate native cancellation to the same upstream request
and to pending retry backoff. Missing provider usage remains unknown (`null`),
including a genuinely completed Chat Completions response; zero-token usage is
not substituted and cached input is not subtracted from the native input count.

An unsupported upstream parameter is not permission to remove its entire
native field and retry. Reasoning effort, tools, parallel-call policy, output
limits, compaction state and input remain intact; the original parameter error
is returned to the native client with its provider details. Success is never
fabricated by silently disabling a requested capability.

Normal threshold-based automatic compaction occurs before the next sampling
request. An unexpected overflow fails the current turn explicitly; a subsequent
turn in the same thread uses Codex's native recovery. Changing models alone is
not a compaction. The bridge does not silently restart a failed user turn or
replay already-published tools.

Premature Responses EOF and Chat Completions EOF without `[DONE]` are explicit
failures. They never create successful completion, zero-token usage or a
compaction count. Both protocols share bounded SSE framing. A real terminal
event releases the upstream immediately, even if its socket stays open.
Isolated regressions exercise automatic thresholds and overflow/failed-summary
recovery against both the selected native Desktop core and the pinned CLI core.
These protocol checks do not substitute for native Desktop visual acceptance
or the six-target release admission evidence.

The existing in-memory request-handler and configuration regressions execute
the production functions without creating profiles, reports or saved fixtures.
They verify transport/state preservation, not a paid large-context inference
benchmark or installer publication.
