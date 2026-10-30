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
`/trajectory/v2/…`, answers `404` (REST §5.4). Paths are compared after URL
normalisation, so a client that reaches `/trajectory/v2/health` through
`/trajectory/v1/../v2/health` still gets `404` — fixture agt-051 relies on
this.

Covered: REST-01..09 and the SSE instance stream (REST-06/07). Not covered
here: action properties (REST-10..12) and the outbound-only variant; those have
their own contract directories.

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
| agt-005 | SHOULD | capabilities carry `visibility`/`supported_commands`; the opaque role's instance reports `visibility: "opaque"` |

## 5. Invoke

**C-AGT-5.** `POST /actions/{action_oid}/invoke` (REST-03) with
`environment_oid`, `workflow_instance_id`, `step_instance_id` and `inputs`
answers `201` with `data.instance_id` (string). A body without
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
| agt-013 | MUST | REST-04 keys; canonical `state.current` |
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
the way MUST be canonical.

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
remains in its terminal state; it never shows a clearing state.

| fixture | level | checks |
|---|---|---|
| agt-020 | MUST | unknown command → 422 `INVALID_COMMAND` |
| agt-021 | IMPL-DEFINED | UNHOLD while EXECUTING → 409/5xx + code (D8) |
| agt-022 | MUST | PAUSE → PAUSED |
| agt-023 | MUST | RESUME → EXECUTING; `RESUMING` only transient |
| agt-024 | MUST | HOLD → HELD |
| agt-025 | MUST | UNHOLD → EXECUTING |
| agt-026 | MUST | STOP → STOPPED |
| agt-027 | MUST | ABORT → ABORTED; CLEAR accepted; never `CLEARING` |
| agt-028 | SHOULD | HOLD while COMPLETING refused (skipped if no window observed) |

## 8. Server-Sent Events

**C-AGT-8.** `GET /instances/{id}/events` (REST-06/07) streams
`event: state_change` frames with an integer `id:` and a JSON object
`data:` carrying `instance_id`, `state` and `previous_state`; `event: output`
frames carry `outputs` (same shape as §6). Frame ids increase within a
stream. The terminal `state_change` (`COMPLETED`, `STOPPED`, `ABORTED`) is the
last frame; when the action has outputs an `output` frame precedes it.

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
| agt-034 | MUST | terminal frame last; output frame before it |

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
- Internal clearing states (`CLEARING`) MUST NOT appear on the wire (agt-027).
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

## Expected results against the reference toy

Against `targets/toy.target.json` with no defects: 29 `pass`, 3 `skip`
(agt-060..062), exit code 0. With a toy defect switched on
(`runner/test/agent-action.test.mjs`):

| defect | fixtures that fail |
|---|---|
| `no-auth` | agt-002, agt-003 |
| `accept-any-command` | agt-020, agt-021 (agt-028 becomes a note) |
| `bad-envelope` | agt-002, agt-010, agt-014 and every other fixture that reads an envelope (§2) |
