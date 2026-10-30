# Agent-as-action contract (`agent-action`)

Conformance clauses for an **action container** exposing the Trajectory
Runtime ↔ Action Container REST protocol at `/trajectory/v1`. This document
restates only what a conformance check needs; the normative text is
[`docs/REST_Protocol.md`](../../docs/REST_Protocol.md), cited below by section
(`REST §1.3`) or endpoint card (`REST-05`). Where the two disagree, the
protocol document wins and the fixture here is wrong.

Levels follow `contracts/README.md`: **MUST** fixtures gate the exit code;
**SHOULD** fixtures record a `note` when unmet; **IMPL-DEFINED** fixtures
record the observed variant and never affect the exit code;
**EXTENSION:<name>** fixtures run only against targets that declare the
extension and never affect the exit code.

Fixtures live in [`fixtures/`](fixtures/), one per file, `agt-<nnn>-<slug>.json`.
Each fixture names the clause it checks in `tags` and its source in `source`.

## 1. Scope

**C-AGT-1.** The container serves the REST surface under a base URL ending in
`/trajectory/v1` (REST §1.1). Any other protocol version prefix, including
`/trajectory/v2/…`, answers `404` (REST §5.4).

Fixture agt-051 requests the step path `/../v2/health`, which the runner
appends to the target's `base_url` (trailing slashes stripped); `fetch`
then normalises the `..` segment per the WHATWG URL standard before sending.
It therefore assumes (a) `base_url` ends in `/trajectory/v1`, so the request
line on the wire is `/trajectory/v2/health`, and (b) no proxy in front of the
container rewrites that path. A target whose
`base_url` has a different shape will send a different URL and the fixture's
result is meaningless for it; set `base_url` as REST §1.1 prescribes.

Covered: REST-01..09, the SSE instance stream (REST-06/07) and, in §13, the
outbound-only variant (C-RLY, fixtures `rly-*`). Not covered here: action
properties (REST-10..12); those have their own contract directory.

| fixture | level | checks |
|---|---|---|
| agt-051 | MUST | `/trajectory/v2/health` → 404 |

## 2. Envelopes

**C-AGT-2.** Every JSON response is wrapped (REST §1.5): a success body is
`{ "data": …, "meta": … }` and an error body is
`{ "error": { "code": <string>, "message": <string> } }`. `meta` MAY be
`{}` but MUST be present. Error codes come from REST §1.6; the fixtures
compare codes exactly where that section fixes them (`UNAUTHORIZED`,
`VALIDATION_ERROR`, `INSTANCE_NOT_FOUND`, `INVALID_COMMAND`) and only require
*a* string code elsewhere.

A container that answers without the envelope fails every fixture that reads
`$.data.*` or `$.error.*` — by design, this is not one defect but the shape of
the whole surface.

## 3. Authentication

**C-AGT-3.** Authenticated endpoints require `X-API-Key` (REST §1.3). A
request without it answers `401 UNAUTHORIZED` in the error envelope. The
`Authorization` header is **reserved**: a request carrying only
`Authorization: Bearer <key>` MUST NOT be authenticated (agt-003). `GET
/health` is reachable without a key (REST-01).

Open-access mode (no key configured) is permitted by the protocol. Targets
in that mode fail agt-002 and agt-003; `HARDENING.md` advises against it and
the toy's `no-auth` defect models it.

| fixture | level | checks |
|---|---|---|
| agt-001 | MUST | `GET /health` 200 without key |
| agt-002 | MUST | authenticated endpoint without key → 401 `UNAUTHORIZED` |
| agt-003 | MUST | bearer-only → 401 `UNAUTHORIZED` |

## 4. Capabilities

**C-AGT-4.** `GET /capabilities` (REST-02) lists `data.environments[]`, each
with `environment_oid` and `actions[]`; each action carries `action_oid`,
`visibility` (`"observable"` or `"opaque"`), `input_parameters`,
`output_parameters` and `supported_commands`,
a subset of the seven canonical commands (`PAUSE`, `RESUME`, `HOLD`, `UNHOLD`,
`STOP`, `ABORT`, `CLEAR`; REST §3.2). An opaque action advertises only
`ABORT` (REST §3.3) and its instances report `visibility: "opaque"`.

| fixture | level | checks |
|---|---|---|
| agt-004 | SHOULD | REST-02 keys; commands ⊆ canonical |
| agt-005 | SHOULD | the opaque role advertises `supported_commands: ["ABORT"]` and its instance reports `visibility: "opaque"` |

## 5. Invoke

**C-AGT-5.** `POST /actions/{action_oid}/invoke` (REST-03) with
`environment_oid`, `workflow_instance_id`, `step_instance_id`, `step_oid` and
`input_parameters` (an array of `{name, value}`) answers `201` with
`data.instance_id` (string). A body without
`environment_oid` answers `400 VALIDATION_ERROR`. An unknown `action_oid`
answers `404` with an error code; the code itself is implementation-defined
(`NOT_FOUND` or `ACTION_NOT_FOUND`, REST §1.6).

Repeating an invoke with the same runtime ids is **IMPL-DEFINED** (D9): the
container MAY return the same `instance_id` or start a new instance. The
fixture asserts only that the repeat is a `201` with a string id; it never
reads `meta.idempotent`.

| fixture | level | checks |
|---|---|---|
| agt-010 | MUST | missing `environment_oid` → 400 `VALIDATION_ERROR` |
| agt-011 | MUST | unknown action → 404 + error code |
| agt-012 | MUST | valid invoke → 201 + string `instance_id` |
| agt-015 | IMPL-DEFINED | repeat invoke → 201 (D9) |

## 6. Instance view

**C-AGT-6.** `GET /instances/{id}` (REST-04) returns `data.instance_id`,
`data.action_oid`, `data.environment_oid`, `data.workflow_instance_id`,
`data.step_instance_id`, `data.visibility`, `data.state.current` (a canonical
state, §11), `data.inputs`, `data.outputs` (an array of `{name, value}`; MAY
be empty) and `data.created_at`. An unknown id answers
`404 INSTANCE_NOT_FOUND`.

| fixture | level | checks |
|---|---|---|
| agt-013 | MUST | REST-04 keys; `instance_id` is the invoked id; canonical `state.current` |
| agt-014 | MUST | unknown id → 404 `INSTANCE_NOT_FOUND` |

## 7. Commands and the state table

**C-AGT-7.** `POST /instances/{id}/command` with `{ "command": <name> }`
(REST-05). A name outside the seven canonical commands answers
`422 INVALID_COMMAND`. A canonical command that is not valid in the current
state is refused; the status is **IMPL-DEFINED** (D8): `409` is the norm and
the toy's answer (`INVALID_STATE_TRANSITION`), a `5xx` with an error code is
an allowed variance. The fixture never asserts the code string.

Accepted commands settle as follows (REST §3.2). "Settles" means the
instance reaches the target state within the wait budget; transient states on
the way MUST be canonical. The transient column is checked only when the
container replays it: agt-023 and agt-025 read the stream with
`Last-Event-ID: 0`, so a `RESUMING`/`UNHOLDING` frame is graded if buffered,
and a container that settles without emitting one still passes (the read then
ends in `timeout` or `end`, both accepted).

| command | from | transient (optional) | settles in |
|---|---|---|---|
| PAUSE | EXECUTING | PAUSING | PAUSED |
| RESUME | PAUSED | RESUMING | EXECUTING |
| HOLD | EXECUTING | HOLDING | HELD |
| UNHOLD | HELD | UNHOLDING | EXECUTING |
| STOP | EXECUTING, PAUSED, HELD | STOPPING | STOPPED |
| ABORT | any non-terminal | ABORTING | ABORTED |
| CLEAR | STOPPED, ABORTED, COMPLETED | — | instance removed, or still terminal |

After `CLEAR` the instance either disappears (`404 INSTANCE_NOT_FOUND`) or
remains in its terminal state; it never shows a clearing state. agt-027
asserts the `200`-or-`404` answer only: the runner has no conditional check,
so it cannot read `state.current` on a body that may be an error envelope.
"No clearing state on the wire" is covered up to the `CLEAR` by the same
fixture's canonical-state checks (wait_state and the SSE read to `ABORTED`),
not by the post-`CLEAR` GET.

| fixture | level | checks |
|---|---|---|
| agt-020 | MUST | unknown command → 422 `INVALID_COMMAND` |
| agt-021 | IMPL-DEFINED | UNHOLD while EXECUTING → 409/5xx + code (D8) |
| agt-022 | MUST | PAUSE → PAUSED |
| agt-023 | MUST | RESUME → EXECUTING; `RESUMING` only transient |
| agt-024 | MUST | HOLD → HELD |
| agt-025 | MUST | UNHOLD → EXECUTING |
| agt-026 | MUST | STOP → STOPPED |
| agt-027 | MUST | ABORT → ABORTED (canonical states only); CLEAR accepted; then 200 or 404 |
| agt-028 | SHOULD | HOLD while COMPLETING refused (skipped if no window observed) |

## 8. Server-Sent Events

**C-AGT-8.** `GET /instances/{id}/events` (REST-06/07) streams
`event: state_change` frames with an integer `id:` and a JSON object
`data:` carrying `instance_id`, `state` and `previous_state`; `event: output`
frames carry `outputs` (same shape as §6). Frame ids increase within a
stream. The terminal `state_change` (`COMPLETED`, `STOPPED`, `ABORTED`) is the
last frame; when the action has outputs an `output` frame precedes it.
agt-034 invokes `fast_action` (which has outputs) and asserts, by negative
index, that `events[-1]` is a terminal `state_change` and `events[-2]` is an
`output` frame whose `outputs[].name` are strings.

Replay (REST §4.1–4.2): agt-031 reads the stream twice. The first read
(`Last-Event-ID: 0`, until `EXECUTING`) captures the id of the last frame
received; the second read replays from that id and MUST return no frames.
The fixture never assumes a particular starting id, so containers whose ids
begin at 0, 1 or any other integer are graded alike (the runner's own test
drives the toy with ids starting at 1 to prove this).

Replay (REST §4.1–4.2): a connection **without** `Last-Event-ID` starts at the
next live event and replays nothing; a connection with `Last-Event-ID: n`
replays buffered frames with `id > n` and nothing else.

The `previous_state` of the first frame is **IMPL-DEFINED** (D11): REST says
`null`, some implementations send the real previous state. The fixture reads
the earliest replayable frame (`Last-Event-ID: 0`) and accepts `null` or a
canonical state.

Opaque instances have no event stream (REST §3.3): the request is refused
with a `4xx` error envelope; the code is implementation-defined (the toy
answers `404 NOT_FOUND`).

Every SSE fixture asserts `$.ended` or uses `until_state`, so a stream that
times out cannot pass silently (checked by `runner/test/levels.test.mjs`).

| fixture | level | checks |
|---|---|---|
| agt-030 | MUST | state_change frames, integer ids, object data |
| agt-031 | MUST | `Last-Event-ID: n` replays only `id > n` |
| agt-032 | IMPL-DEFINED | first `previous_state` null or canonical (D11) |
| agt-033 | SHOULD | opaque instance stream → 4xx envelope |
| agt-034 | MUST | `events[-1]` terminal state_change; `events[-2]` output with named outputs |

## 9. List and delete

**C-AGT-9.** `GET /instances` (REST-08) answers `data` as an array and
`meta.total` as an integer. `DELETE /instances/{id}` (REST-09) force-cancels
and succeeds with a `2xx`; a repeat answers `2xx` or `404`, never `5xx`.

| fixture | level | checks |
|---|---|---|
| agt-040 | SHOULD | list shape |
| agt-041 | SHOULD | delete, repeat delete idempotent |

## 10. CORS

**C-AGT-10.** A preflight `OPTIONS` from the runtime origin
(`roles.cors_origin` in the target) answers with
`Access-Control-Allow-Headers` naming `X-API-Key` and `Last-Event-ID`
(REST §1.4). The origin MAY be echoed or `*`; `*` is not required and
`HARDENING.md` advises against it, so a target that answers `*` is reported
as a note by the reviewer, not by the fixture (the runner has no
"header must not equal" rule).

| fixture | level | checks |
|---|---|---|
| agt-050 | SHOULD | preflight allows `X-API-Key`, `Last-Event-ID` |

## 11. State-machine variance

**C-AGT-11.** The canonical states are those of REST §3.1. An implementation
MAY emit any subset of them, but every state that appears on the wire — in
`state.current` or in an SSE `state`/`previous_state` — MUST be canonical.
Known variants, listed *as allowed*:

- `RESUMING` is the canonical wire name; an implementation whose internal
  name is `UNPAUSING` MUST map it (agt-023).
- Implementations without an internal STOPPED MUST still report `STOPPED`
  after `STOPPING` (agt-026).
- Internal clearing states (`CLEARING`) MUST NOT appear on the wire. agt-027
  checks every state it sees up to the `CLEAR` is canonical; it cannot inspect
  the state after `CLEAR` because the instance may legitimately be gone (§7).
- HOLD from `COMPLETING` MUST be rejected on the wire even if the internal
  machine allows it (agt-028; SHOULD because a container may never expose a
  `COMPLETING` window long enough to observe).
- STOP on opaque actions is IMPL-DEFINED and not fixtured.

## 12. Extensions

**C-AGT-12.** Extension fixtures run only when the target declares the
extension in `extensions` and provides every role in `requires`; otherwise
the runner records `skip` with the first missing requirement as the reason.

### `change-guard`

A guarded action requires an `approval` object in the invoke body. Without
one the container answers `400 CHANGE_NOT_APPROVED`; with an approval whose
`change_hash` does not match the requested change it answers
`400 CHANGE_HASH_MISMATCH`; with a matching approval it answers `201`. The
target supplies `roles.guarded_action` and `roles.guarded_change_hash`.

| fixture | level | checks |
|---|---|---|
| agt-060 | EXTENSION:change-guard | no approval → 400 `CHANGE_NOT_APPROVED` |
| agt-061 | EXTENSION:change-guard | hash mismatch → 400 `CHANGE_HASH_MISMATCH` |
| agt-062 | EXTENSION:change-guard | matching approval → 201 |

The reference toy target (`targets/toy.target.json`) does not declare
`change-guard`; these three fixtures skip against it.

## 13. Outbound-only variant (C-RLY)

An action server may be a **door**: the HTTP surface of §§2–10 runs where the
Runtime can reach it, and the agent that does the work dials *out* to the
door and is never called inbound. The Runtime cannot tell a door from a
directly hosted action server, and must not need to: **a door MUST pass every
`agt-*` fixture.** The clauses below add what a relay changes. A target
declares that it is a door with the capability `outbound_only` (it implies no
roles); the observed `rly-*` fixtures (rly-001..003) run only against targets
declaring it and skip otherwise. rly-004 is graded by attestation alone.

**C-RLY-1. Fail fast when the agent is away.** An invoke of an action whose
agent is not connected answers `409` with `$.error.code` equal to
`AGENT_UNAVAILABLE`; a `409` carrying any other code fails. It MUST NOT answer
`201` and leave the instance to hang. A door that answers `503` instead is
recorded as a `note`, not a failure; on the `503` path the error code is only
required to be a string (`SERVICE_UNAVAILABLE` is the conventional value).

**C-RLY-2. Retried dispatch does not start work twice.** A relay retries, so
an invoke SHOULD be idempotent on
(`environment_oid`, `workflow_instance_id`, `step_instance_id`, action): the
same four values answer `201` with the *same* `instance_id`. Different runtime
ids MUST give a different instance; de-duplication keys on the ids, never on
the action alone. The reference door derives its key as `rai-` + the first 24
hex digits of sha256(`env|wf|step|action`); the format is IMPL-DEFINED and
only "same id" / "different id" is checked. For a server that is not a door
this is agt-015's D9 choice; a door is held to the SHOULD.

**C-RLY-3. Reported state does not lag the agent beyond the target's
`timeouts.wait_s`.** A door polls or streams from its agent; however it does
so, the state it reports MUST settle within the wait budget the target
profile declares. This is checked as "the `wait_state` after a command
succeeds within `timeouts.wait_s`": the §7 command fixtures (agt-022..028)
already do exactly that, so no `rly-*` fixture repeats it. A door whose state
lags longer fails those fixtures.

**C-RLY-4. No inbound port on the agent's network.** The door MUST NOT require
the agent to accept a connection. This is not observable over HTTP, so it is
graded by **attestation**: the target profile may declare
`"attestations": { "C-RLY-4": true }`, and the runner records
`note` with reason `attested: C-RLY-4 …` and evidence
`{attestation, attested}`. A fixture graded by attestation is never a `pass`;
without the attestation (absent or `false`) it is a `skip` naming the clause.

| fixture | level | requires | checks |
|---|---|---|---|
| rly-001 | MUST | `outbound_only`, `roles.offline_action` | invoke → 409 with `$.error.code` = `AGENT_UNAVAILABLE`, no `instance_id` (503 → note, code any string) |
| rly-002 | SHOULD | `outbound_only`, `roles.observable_action` | same ids twice → 201, same `instance_id` |
| rly-003 | MUST | `outbound_only`, `roles.observable_action` | different `step_instance_id` → 201, different `instance_id` |
| rly-004 | MUST | — | `attests: C-RLY-4` → note when attested, else skip |

The reference toy declares `outbound_only` so the `rly-*` fixtures run
against it, and attests C-RLY-4: it is in-process and has no agent listener
at all, so the attestation is true by construction. rly-004 is therefore a
`note` against the toy, never a `pass`.

## Expected results against the reference toy

Against `targets/toy.target.json` with no defects, the whole category
(agt-* and rly-*) gives 32 `pass`, 1 `note` (rly-004), 3 `skip`
(agt-060..062), zero `fail`, exit code 0; the `agt-*` fixtures alone are
29 `pass`, 3 `skip`. With a toy defect switched on
(`runner/test/agent-action.test.mjs`):

| defect | fixtures that fail |
|---|---|
| `no-auth` | agt-002, agt-003 |
| `accept-any-command` | agt-020, agt-021 (agt-028 becomes a note) |
| `bad-envelope` | agt-002, agt-010, agt-014 and every other fixture that reads an envelope (§2) |

The `rly-*` fixtures (§13, pinned by `runner/test/relay.test.mjs`): rly-001,
rly-002 and rly-003 `pass`; rly-004 is `note` (`attested: C-RLY-4`); zero
`fail`, exit code 0. With the toy defect `non-idempotent-invoke` only rly-002
changes, to `note` (`SHOULD not met`); the `agt-*` outcomes are unchanged
except agt-015, which records the other D9 variant (its pin allows `pass` or
`note`; against the toy it passes either way). Against a target that does
not declare `outbound_only`, rly-001..003 `skip` (reason names
`outbound_only`) and rly-004 is still graded by attestation.
