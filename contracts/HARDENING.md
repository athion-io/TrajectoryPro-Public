<!--
Copyright 2026 Athion, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Hardening findings

This is the list of things we found while writing the contracts in this
folder that we think should change — in the protocol document, in the
reference container, or in the runtimes that talk to it. It is a findings
list, not a contract: nothing here is a MUST until it lands in a `CONTRACT.md`
and a fixture.

How to read each finding:

- **what** — the behaviour, in one or two sentences.
- **where** — `file:line` at commit `20c12ab` of this repository (the
  read-only copy the contracts were written against). Line numbers were
  checked against that commit; they will drift on later commits.
- **risk** — what goes wrong if it stays as it is.
- **proposal** — the change we suggest.
- **contract hook** — the fixture or clause in this folder that observes the
  behaviour today, or "no runtime check possible" when nothing can.
- **severity** — H / M / L. Severities are Marsha's call and are recorded
  as given; they are not derived from the evidence.

Fixture ids (`agt-…`, `rly-…`, `prm-…`, `cfg-…`) live under
`<contract>/fixtures/`; clauses (`C-AGT-n`, `C-RLY-n`, …) live in the
matching `CONTRACT.md`. REST section numbers refer to `docs/REST_Protocol.md`.

---

## 1. Open access when no API key is configured

**Severity: H**

**what** — The protocol allows a server to run with no `api_key` configured,
in which case every `/trajectory/v1/*` request is accepted regardless of
headers, and says new containers SHOULD support that mode.

**where**

- `docs/REST_Protocol.md:55` — "Open access | No `api_key` configured … All
  `/trajectory/v1/*` requests are accepted regardless of headers."
- `docs/REST_Protocol.md:58` — "new containers SHOULD support both modes."
- Reference container, for contrast: `MissionAutopilot/packages/server/src/index.ts:109-116`
  refuses to start when `ACTIONS_API_KEY` is unset or shorter than 32
  characters (`process.exit(1)`); `MissionAutopilot/packages/server/src/config.ts:15-21`
  (`MIN_API_KEY_LENGTH = 32`, `readApiKey` returns `null` otherwise);
  `MissionAutopilot/packages/server/src/index.ts:57` binds
  `HOST = process.env.HOST ?? '127.0.0.1'`.

Note the honest position: at `20c12ab` the **reference code already does the
hardened thing** — it will not boot without a key. The gap is in the
**protocol document**, which still permits open access and recommends that
new containers support it. Any other implementation written from the
document inherits the risk.

**risk** — A container built to the document can be deployed listening on a
non-loopback address with no authentication. Anyone who can reach the port can
invoke actions, send commands and delete instances.

**proposal** — Change REST §1.3 so that open access is only permitted when
the server binds a loopback address; a container MUST refuse to boot on a
non-loopback bind without a key. Drop "new containers SHOULD support both
modes". The reference container's current behaviour (refuse without a key,
default to `127.0.0.1`) is the model.

**contract hook** — agt-002 (MUST, C-AGT-3 §3: authenticated endpoint
without key → 401) and agt-003 fail against a target in open-access mode; the
toy's `no-auth` defect (`runner/test/toy-container.mjs:26`) models it. The
runner cannot see the bind address, so "loopback only" is not checkable at
runtime.

## 2. CORS `Access-Control-Allow-Origin: *`

**Severity: H**

**what** — The protocol tells servers to answer every origin with `*`.

**where**

- `docs/REST_Protocol.md:67` — `Access-Control-Allow-Origin:  *` (under
  "Servers SHOULD expose", line 64).
- Reference container, for contrast: `MissionAutopilot/packages/server/src/index.ts:171-181`
  uses `cors()` with an `origin` callback into `isOriginAllowed`;
  `MissionAutopilot/packages/server/src/config.ts:49-67` allows loopback
  origins always and otherwise only the `ACTIONS_ALLOWED_ORIGINS` allowlist.

As with finding 1, the reference code at `20c12ab` is already stricter than
the document; the document is what other implementations will follow.

**risk** — A browser page on any origin can drive an authenticated session
against the container (the key is sent by the page, so `*` is not the only
gate, but it removes the browser's defence in depth and makes a leaked key
usable from anywhere a user browses).

**proposal** — REST §1.4 should require an explicit origin allowlist, with
loopback origins permitted by default and `*` disallowed. Also add
`Authorization` to the documented `Allow-Headers` list only if finding 3 is
resolved in favour of keeping it; today `index.ts:178` allows it and the
document (line 69) does not.

**contract hook** — agt-050 (SHOULD, C-AGT-10 §10). The runner has no
"header must not equal" rule, so agt-050 checks the preflight answers and
that `Last-Event-ID` is allowed; a target answering `*` passes the fixture and
is flagged by the reviewer note in C-AGT-10, as the clause says.

## 3. The Tester authenticates with `Authorization` and `?token=`

**Severity: M**

**what** — The Mission Autopilot Tester sends the key as
`Authorization: Bearer …` on every REST call and as `?token=…` on the SSE
URL. The protocol says the key travels in `X-API-Key` and that
`Authorization` is reserved.

**where**

- `MissionAutopilotTester/src/api/capabilities.ts:23-24`,
  `MissionAutopilotTester/src/api/commands.ts:30-31`,
  `MissionAutopilotTester/src/api/instances.ts:23-24`,
  `MissionAutopilotTester/src/api/invoke.ts:30-31` — each sets
  `headers.Authorization = Bearer <apiKey>`. (The brief cites
  `capabilities.ts:24` and `commands.ts:31`; those match. `instances.ts` has
  the same line at 24.)
- `MissionAutopilotTester/src/features/upload/EnvirXUploader.tsx:40` — the
  management upload also sends `Authorization: Bearer <apiKey>`.
- `MissionAutopilotTester/src/store/use-instance-stream.ts:100` — appends
  `?token=<apiKey>` to the event-stream URL.
- `MissionAutopilotTester/src/features/connection-bar/ConnectionModal.tsx:112`
  — helper text "Sent as 'Authorization: Bearer …'".
- `docs/REST_Protocol.md:43-46` — `X-API-Key: <secret>`;
  `docs/REST_Protocol.md:60` — "The `Authorization` header is reserved for
  future bearer/OAuth flows."
- Why it works today: `MissionAutopilot/packages/server/src/middleware/auth.ts:29-44`
  (`extractKey`) accepts `x-api-key` (30-31), `Authorization: Bearer`
  (33-37) **and** `?token=` on GET event-stream paths (39-43, path regex at
  line 27 with its comment at 26).
  `MissionAutopilot/packages/server/src/index.ts:183-184` redacts `?token=`
  from access logs, which shows the leak was known.

**risk** — Tokens in query strings end up in proxy logs, browser history and
referrer headers. The reference container accepting `Authorization` means
the "reserved" header is already in use, so a future bearer/OAuth flow
cannot reuse it without breaking the Tester. Other runtimes written from the
Tester as an example will copy both habits.

**proposal** — The Tester sends `X-API-Key` on REST calls. For SSE, where
`EventSource` cannot set headers, use `fetch` with a streaming body reader
(the runner does this) or a short-lived, single-use stream ticket — never the
long-lived key in a query string. The reference container should stop
accepting `?token=` once the Tester is fixed, and either stop accepting
`Authorization` or the protocol should un-reserve it.

**contract hook** — agt-003 (MUST, C-AGT-3 §3: a request carrying only
`Authorization: Bearer …` MUST NOT be authenticated). Limitation to be aware
of: agt-003 sends a **bogus** bearer value, so it catches a server that
authenticates any bearer; it cannot detect a server that honours a *correct*
key sent as a bearer, which is what `auth.ts:33-37` does. The reference
container therefore passes agt-003 while still being over-accepting relative
to REST §1.3. There is no fixture for `?token=` (no runtime check possible
without the real key in the URL).

## 4. A state-invalid command answers 5xx in the reference container

**Severity: M**

**what** — The protocol says the wire shape of "command not valid in this
state" is implementation-defined and that the reference container answers
"a 5xx with `code: INSTANCE_ERROR` (or similar)".

**where**

- `docs/REST_Protocol.md:407` — "The wire shape of that rejection is
  implementation-defined; the reference container surfaces it as a 5xx with
  `code: INSTANCE_ERROR` (or similar)."
- What the reference does at `20c12ab` (it has moved on from the document):
  `MissionAutopilot/packages/engine/src/errors.ts:33-41`
  (`InvalidStateTransitionError`, code `INVALID_STATE_TRANSITION`, comment
  "Maps to HTTP 409");
  `MissionAutopilot/packages/server/src/middleware/error-handler.ts:27`
  (`INVALID_STATE_TRANSITION: 409`) and `:42-54` (409 envelope with
  `details.current_state` and `details.command`). Thrown from
  `MissionAutopilot/packages/engine/src/state-machine/transitions.ts:188,193`.
- No `INSTANCE_ERROR` string exists in `MissionAutopilot/packages/**` at
  `20c12ab` (checked with `git grep`); the document's description of the
  reference is stale.

**risk** — Two things. (a) The document and the reference disagree, so a
runtime written from the document retries or alarms on a 5xx that is really
a client-side race. (b) "Implementation-defined" means every runtime needs
per-container handling for the single most common command error.

**proposal** — Pin it: a state-invalid command answers `409` with a fixed
code. Decision D8 names `INSTANCE_ERROR`; the reference already uses
`INVALID_STATE_TRANSITION`. Pick one (we lean to the reference's
`INVALID_STATE_TRANSITION` because it is already shipped and more specific)
and update REST §3.2 / REST-05 and the C-AGT-7 table so that it is a MUST,
not IMPL-DEFINED.

**contract hook** — agt-021 (IMPL-DEFINED, C-AGT-7 §7, D8): passes only on
`409` with an `error.code` present, notes on any `500-599` (the D8 variance),
and fails on any other status. Once pinned it becomes a MUST on 409 and the
chosen code.

## 5. No client idempotency key on invoke

**Severity: M**

**what** — `POST /actions/{oid}/invoke` has no idempotency key. A runtime
that times out and retries cannot tell whether the first request started an
instance.

**where**

- `docs/REST_Protocol.md:246-272` — REST-03 request body table: no
  idempotency field, and no `Idempotency-Key` header anywhere in the document
  (`git grep -i idempot 20c12ab -- docs` → no hits).
- `MissionAutopilot/packages/engine/src/instance-manager/instance-manager.ts:433-467`
  — `invoke()` always creates a new instance (`instanceRepo.create`, line
  455); nothing looks up an existing instance by `workflow_instance_id` /
  `step_instance_id` first.
- `MissionAutopilot/packages/server/src/routes/protocol.ts:207-217` — the
  invoke body validator lists the accepted fields; none is an idempotency
  key.

**risk** — A retried invoke runs the action twice on the plant. For an
outbound-only door (C-RLY) the retry is the normal path, not the exception
(C-RLY-2).

**proposal** — v1.1 adds an optional `Idempotency-Key` request header. When
present, a container MUST return the same `instance_id` (and `201`) for a
repeat with the same key within a retention window. When absent, the door's
derived key — `(environment_oid, workflow_instance_id, step_instance_id,
action)` — is the fallback, which is what D9 and C-RLY-2 already describe.

**contract hook** — agt-015 (IMPL-DEFINED, C-AGT-5 §5, D9: repeat invoke →
201, same or new id) and rly-002 (SHOULD, C-RLY-2 §13: repeat invoke with the
same runtime ids → same instance). Neither sends `Idempotency-Key`; a v1.1
fixture would.

## 6. Every app has its own sign-in; the user never reaches the action server

**Severity: M**

**what** — Commander and Designer each run their own better-auth sign-in;
Autopilot authenticates with a single service key; the Tester asks for that
key in a dialog. Nothing on the wire from a runtime to a container carries
*which user* asked for the action.

**where**

- `MissionCommander/src/server/app.ts:86` — mounts its own auth handler on
  `/api/auth/*` (`MissionCommander/src/routes/login.tsx` is the page).
- `MissionDesigner/src/server/index.ts:152` — mounts a separate auth handler
  on `/api/auth/*`; `MissionDesigner/src/server/middleware/authRateLimit.ts:42-43`
  throttles its own sign-in/sign-up.
- `MissionAutopilot/packages/server/src/index.ts:109-116,207,223` — one
  service key (`ACTIONS_API_KEY`) gates both `/trajectory/v1` and
  `/management/v1`; there is no per-user identity.
- `MissionAutopilotTester/src/features/connection-bar/ConnectionModal.tsx:112`
  — the user types the service key by hand.
- `docs/REST_Protocol.md:43-60` — the only authentication is the key; no
  user field in any REST-03 body field (lines 246-272).

**risk** — Audit records at the container end say "the service key did it".
Operator accountability (who invoked, who approved) stops at the runtime
boundary; permission checks (the `permission` contract) cannot be enforced by
the container because it does not know the subject.

**proposal** — Forwarded identity (auth option B, Task 7): the runtime keeps
sending the service key in `X-API-Key` and adds a second header carrying a
signed user token; the container verifies it and uses it for permission and
audit. Commander gains a slot that mints/holds the user token for its
outbound calls. The header name is a question for Dennis (see the open
questions below).

**contract hook** — agt-070, agt-071, agt-072 (EXTENSION
`forwarded-identity`, C-AGT-12 §12): invalid token → 401, ungranted user →
403, granted user → 201. They run only when the target declares the
extension; the toy declares it unsupported, so they skip against it.

## 7. The first `previous_state: null` rule cannot be observed

**Severity: L**

**what** — REST says `previous_state` is `null` for the first `state_change`
event of an instance. A client that connects after the first event, or
reconnects with `Last-Event-ID`, never sees that frame, and the server starts
a fresh connection from the next live event.

**where**

- `docs/REST_Protocol.md:445` — "`previous_state` is `null` for the first
  event."
- `docs/REST_Protocol.md:735` — "If `Last-Event-ID` is absent on first
  connect, the server starts the stream from the next live event."
- Reference: `MissionAutopilot/packages/server/src/index.ts:135-136`
  computes `previousState` from the stored history (null only when history
  has fewer than two entries); `MissionAutopilot/packages/server/src/routes/commands.ts:133-143`
  replays the ring buffer only when `Last-Event-ID` is present.

**risk** — Low. A runtime that treats the first-frame rule as a contract may
wait for a `null` that never arrives. The rule is also unverifiable by any
conformance tool, so it cannot be a MUST.

**proposal** — Reword REST §3.2 to "when the first `state_change` is
delivered, `previous_state` is `null`" and keep it informative. Decision D11
already records it as IMPL-DEFINED.

**contract hook** — agt-032 (IMPL-DEFINED, C-AGT-8 §8, D11): checks that
`previous_state` is a canonical state or `null`; it does not assert the
`null` on any particular frame.

## 8. Opaque SSE: the refusal code is unspecified

**Severity: L**

**what** — Opaque actions do not open an SSE stream, but the protocol does not
say what `GET /instances/{id}/events` answers for an opaque instance — the
status, the error code, or whether it simply streams nothing.

**where**

- `docs/REST_Protocol.md:277` — "For `"opaque"` actions … No SSE stream is
  opened."
- `docs/REST_Protocol.md:702-711` — §3.3 table: "SSE stream | Not opened by
  the container. Runtime polls REST-04."
- `docs/REST_Protocol.md:100-111` — the error-code table has no entry for it.
- Reference: `MissionAutopilot/packages/server/src/routes/commands.ts:108-167`
  — the events route checks only that the instance exists (404
  `INSTANCE_NOT_FOUND` at 115-120) and then opens a stream for **any**
  instance; there is no opaque check (`git grep -i opaque` on
  `packages/server/src/routes/commands.ts` → no hits; the only `opaque`
  mentions under `routes/` are in `management.ts` and `export-import.ts`,
  which do not serve the events route). So the reference streams for opaque
  instances rather than refusing.

**risk** — Low. A runtime cannot tell "this is opaque, poll instead" from
"this stream is broken" without reading capabilities first.

**proposal** — Pin a response: `409` (or `400`) with a fixed code such as
`NO_EVENT_STREAM`, and add it to the REST §1.6 table. If the reference
prefers to keep streaming for opaque instances, say so in §3.3 instead and
make the runner accept both.

**contract hook** — agt-033 (SHOULD, C-AGT-8 §8, REST §3.3): accepts any 4xx
with a string `error.code`; the code itself is not pinned. Against the
reference at `20c12ab` this fixture would not pass (it streams 200), which is
one of the expected Task 18 results.

## 9. `NOT_FOUND` vs `INSTANCE_NOT_FOUND` vs `ACTION_NOT_FOUND` at invoke

**Severity: L**

**what** — The document's 404 row for an unknown action OID at invoke is
self-contradictory ("surfaced via `INSTANCE_NOT_FOUND` semantics … some
legacy paths use `NOT_FOUND`"), and the reference answers a third code.

**where**

- `docs/REST_Protocol.md:108` — 404 `NOT_FOUND` row: "unknown action OID at
  invoke time, surfaced via `INSTANCE_NOT_FOUND` semantics by the engine;
  some legacy paths use `NOT_FOUND`".
- Reference: `MissionAutopilot/packages/engine/src/instance-manager/instance-manager.ts:437-441`
  throws `EngineError('ACTION_NOT_FOUND', …)`;
  `MissionAutopilot/packages/server/src/middleware/error-handler.ts:25`
  maps `ACTION_NOT_FOUND: 404`. The storage `NotFoundError` path at
  `error-handler.ts:69-77` is the `NOT_FOUND` "legacy" code.

**risk** — Low. Clients that parse `error.code` (REST §1.6 says they MUST)
need three spellings for one condition.

**proposal** — Add `ACTION_NOT_FOUND` to the REST §1.6 table as the invoke
code, drop the `INSTANCE_NOT_FOUND`-semantics sentence, and keep `NOT_FOUND`
only as the generic fallback.

**contract hook** — agt-011 (MUST, C-AGT-5 §5): unknown action → 404 and
`error.code` is a string; the code name is deliberately not pinned
(`NOT_FOUND` or `ACTION_NOT_FOUND` are both accepted).

## 10. `expose_traceback` in 500 details

**Severity: L**

**what** — The protocol lets a container put a "sanitized traceback" in the
500 error `details` when `expose_traceback` is enabled in its settings. The
default is not stated.

**where**

- `docs/REST_Protocol.md:111` — "Container MAY include a sanitized traceback
  in `details` if `expose_traceback` is enabled in its settings."
- Reference: `MissionAutopilot/packages/server/src/routes/protocol.ts:129`
  — "`_settingsRepo` reserved for plan 05-02 (expose_traceback)": not
  implemented at `20c12ab`. `MissionAutopilot/packages/server/src/middleware/error-handler.ts:101-110`
  answers a fixed `INTERNAL_ERROR` with empty `details` and logs the error
  server-side only.

**risk** — Low today (the reference does not implement it). When it does, a
traceback reveals file paths, module names and sometimes parameter values to
any caller who can trigger a 500.

**proposal** — REST §1.6 states that `expose_traceback` MUST default to off,
and that when on the traceback MUST NOT include request bodies or
environment values. Keep the reference's current behaviour as the default.

**contract hook** — no runtime check possible: a fixture would have to
provoke an unhandled 500 in the target, which the contracts deliberately do
not do.

## 11. Primitives vs JCS canonicalisation

**Severity: L (proposed; Marsha to confirm) — one difference found, fixed
in the runner, closed**

**what** — Twelve golden vectors (`{input, canonical, hash}`) were generated
by the Athion canonicalisation primitives (recipe `athion-canon/2`,
primitives commit `c115860f6f1f75a270dc20181e0580f000fa3154`) and replayed
through the runner's `contracts/runner/src/jcs.mjs`. Ten matched byte for
byte at once. Two did not: `number-large` (`1e+20`, `1e+21`) and
`event-linked-unicode-numbers` (a payload holding `1e+21`). The primitives
render them exactly as RFC 8785 says (`100000000000000000000` and `1e+21`,
the ECMAScript `Number::toString` form); the runner refused every number
with `|n| > 2^53-1` outright, a restriction it had taken from I-JSON
(RFC 7493) that the RFC itself does not impose. After the restriction was
removed all twelve vectors match, canonical string and digest, and the
three event vectors chain (`prev_hash` of each equals the recomputed hash
of the one before; the genesis `prev_hash` is `""`, as C-AUD-4 says).

**where** — `contracts/audit-trail/fixtures/vectors/audit-vectors.json`
(SHA-256 `0aa401b8322fa54aa29d13bafd819bfb1beef10845e5ecf48461953aaf43eaaa`,
copied unchanged from the generator's output) and
`contracts/runner/src/jcs.mjs` (`numberText`). Nothing in the reference
container or the protocol document is involved: the reference does not
hash audit events at `20c12ab`.

**risk** — With the restriction in place, a trail whose payload carried a
large number (a flow total, a timestamp in nanoseconds, a serial) would hash
fine in the runtime and then be refused as "not events" by the runner, so a
good trail could never be verified and a tampered one could hide behind the
refusal. With it removed, the runner and the primitives agree on every
vector; the remaining risk is a third implementation that prints large
doubles differently (for example `1e+20` instead of
`100000000000000000000`). The vectors now pin that case, so such an
implementation fails C-AUD-3 visibly instead of silently.

**proposal** — None for the protocol. Implementers who write their own
canonicaliser should run it against `audit-vectors.json` before trusting
their hashes; the file is the shared truth for the number cases. A runtime
that wants to avoid the question entirely can keep payload numbers within
±(2^53-1), but that is advice, not a clause.

**contract hook** — `contracts/runner/test/jcs.test.mjs`, "golden vectors
from primitives": asserts the file's SHA-256, then for every vector that
`canonicalize(input)` equals `canonical` byte for byte and that
`sha256(canonical)` equals `hash`; for the event vectors it also asserts
`eventHash` and the chain links. C-AUD-3 names the file.

## 12. Reference-container fixture failures

**Severity: pending Task 18 (blocked: needs Dennis's container to be started)**

**what** — Placeholder. Task 18 runs the agent-action fixtures against the
reference Mission Autopilot container and lists every fixture that does not
pass, by fixture id, with the observed response.

Expected from the evidence above, to be confirmed by the run:

- agt-011 — passes (404 `ACTION_NOT_FOUND`; code name not pinned).
- agt-021 — passes as IMPL-DEFINED (409 `INVALID_STATE_TRANSITION`, finding 4).
- agt-032 — passes as IMPL-DEFINED (D11, finding 7).
- agt-033 — expected to fail: the reference streams for opaque instances
  (finding 8).
- agt-050 — passes; reviewer note if the configured origin answers `*`
  (finding 2; the reference does not).
- rly-004 — note (`attested: C-RLY-4`) only if the target profile attests.

**where / risk / proposal / contract hook** — *pending Task 18.*

> Task 18 updates this section with the real results.

## 13. The Mission Broker authenticates with `Authorization` only and refuses outside the envelope

**Severity: M (proposed; Marsha to confirm)**

**what** — The Mission Broker is a `/trajectory/v1/*` action server (the
Distributed Workflow actions). It reads the key from `Authorization:
Bearer <token>` only — never `X-API-Key` — and answers an unauthenticated
request with `401 { "error": "missing or wrong broker token" }`, a string
rather than the `{ error: { code, message } }` envelope every other error
on its routes uses. Its `/health` is at the root only and answers
`{ ok: true }`.

**where**

- `MissionBroker/src/auth.ts:37-38` — `brokerAuth` reads
  `c.req.header('authorization')` and strips a `Bearer ` prefix; no
  `x-api-key` lookup anywhere in the file. `:39` — `?token=` on
  `GET /trajectory/v1/instances/:id/events` only. `:40` — the 401 body
  `{ error: BROKER_TOKEN_ERROR }` (`BROKER_TOKEN_ERROR` at `:18`).
- `MissionBroker/test/auth.test.ts:36-48` — pins that exact 401 body for
  all six authenticated routes as "the spec body", so it is deliberate,
  not an accident.
- `MissionBroker/src/app.ts:51` — CORS `allowHeaders` is
  `['Authorization', 'Content-Type']`; a browser sending `X-API-Key`
  would be refused at preflight even if the server read it.
  `src/app.ts:54` — `app.get('/health', (c) => c.json({ ok: true }))`;
  the action routes from `:56` are under `/trajectory/v1/`.
- `MissionEngine/src/actions/client.ts:235-241` — the engine sends
  `Authorization: Bearer` to the broker origin and `X-API-Key` to the
  Mission Autopilot origin, "each credential goes to its own origin only".
- `docs/REST_Protocol.md:43-46` — `X-API-Key: <secret>`;
  `docs/REST_Protocol.md:60` — `Authorization` is reserved.
  `agent-action/CONTRACT.md:58-62` — C-AGT-3.

**risk** — A runtime written to REST §1.3 cannot talk to the Broker without
a per-server exception for the header, and cannot tell a Broker auth
failure from a malformed response because the 401 has no `code`. The
reserved `Authorization` header is in use on a second server (finding 3
records the first), which narrows the room for a future bearer/OAuth flow.
The engine's credential split is sound — a different key per origin is the
right isolation — but it is implemented as a different *header*, which is
what the protocol forbids. Health checkers that expect `$.data.status`
under `/trajectory/v1/health` (agt-001, REST-01) get a 404 or a different
shape.

**proposal** — The Broker accepts `X-API-Key` per REST §1.3 and answers
401 in the standard envelope (`{ error: { code: "UNAUTHORIZED", message }
}`). Keep a separate broker credential: the engine sends it as
`X-API-Key: <broker key>` to the broker origin, which satisfies both the
per-origin isolation in `client.ts` and the protocol. Add `X-API-Key` to
the CORS `allowHeaders`. Keep `?token=` on the events path only until the
SSE ticket from finding 3 exists, then drop it. Serve `/trajectory/v1/health`
with `$.data.status`, keeping the root `/health` if anything depends on it.

**contract hook** — agt-002 and agt-003 (MUST, C-AGT-3): both are sent
with `auth: false` and assert `$.error.code == "UNAUTHORIZED"`, so both
fail today on the body shape whatever the target profile says. agt-003's
bogus bearer is correctly refused, so the Broker meets the "MUST NOT be
authenticated" rule and fails only on the envelope. agt-001 (MUST, REST-01)
fails on the health shape. agt-004 onward pass only when the target
profile sets `auth.header: Authorization` and `auth.scheme: Bearer`
(`runner/src/http.mjs:86-89`), which a conforming server must not need.
See `REUSE-REPORT.md`, Mission Broker row.

---

## Open questions for Dennis

Collected from the contracts in this folder. Each points at the section that
raises it.

1. **Forwarded-identity header name.** The contracts propose
   `X-Trajectory-User: Bearer <user token>` next to `X-API-Key`. Is that the
   name, and is a bearer-style value right? — `agent-action/CONTRACT.md` §12
   `forwarded-identity`; finding 6.
2. **`subject.mode`.** The agent's highest action mode travels on the
   permission subject because nothing on the wire carries a per-agent
   identity. Right place, and is `observe < test < configure` the right
   ladder? — `permission/CONTRACT.md` §5.1 item 1.
3. **The `commander` role name.** The permission contract names the
   per-work-center "Mission System Commander" flag as a role called
   `commander`. Keep it, or use the product's own name? —
   `permission/CONTRACT.md` §5.1 item 2.
4. **`view` scope.** Shipped Commander lets a control grant also grant
   cross-centre reads; the toy keeps `view` in-work-center. Which does the
   contract pin? No fixture tests it until answered. —
   `permission/CONTRACT.md` §5.1 item 3.
5. **Role-name mapping.** Fixtures send `viewer` / `operator` / `commander` /
   `agent` literally; the target profile has no mapping slot. Should the
   profile gain one, or does each target's probe translate? —
   `permission/CONTRACT.md` §5.1 item 4.
6. **cfg-1xx live fixtures: `source` body shape, route names, placeholder
   item.** `"source": {"kind": "live", "route": "download" | "reload"}` and
   the `LIVE_OBJECT/LIVE_PARAMETER` item are provisional pending plan 4
   (D13). — `config-connector/CONTRACT.md` §4.
7. **Connector probe error codes.** The probe answers `409 STALE_VALUE`,
   `400 ITEM_NOT_FOUND` and `400 VALIDATION_ERROR` (duplicate item, unknown
   profile, non-UTF-8). These are probe-local today; should any become part
   of the vendor-facing contract? — `config-connector/CONTRACT.md` §1
   (error table) and §3 (probe).
8. **State-invalid command code.** D8 says `409 INSTANCE_ERROR`; the
   reference ships `409 INVALID_STATE_TRANSITION`; the document says 5xx.
   Which one? — finding 4; `agent-action/CONTRACT.md` §7 (agt-021).
9. **Opaque SSE refusal.** Refuse with a pinned code, or keep streaming for
   opaque instances as the reference does? — finding 8;
   `agent-action/CONTRACT.md` §8 (agt-033).
10. **Unknown action at invoke.** Pin `ACTION_NOT_FOUND`? — finding 9;
    `agent-action/CONTRACT.md` §5 (agt-011).
11. **`previous_state: null` on the first frame.** Keep as informative
    (D11) or drop? — finding 7; `agent-action/CONTRACT.md` §8 (agt-032).
12. **`Idempotency-Key` in v1.1.** Header name and retention window. —
    finding 5; `agent-action/CONTRACT.md` §5 and §13 (agt-015, rly-002).
13. **`Authorization` header.** Keep it reserved (and have the reference stop
    accepting a bearer key), or un-reserve it? — finding 3;
    `agent-action/CONTRACT.md` §3 (agt-003).
