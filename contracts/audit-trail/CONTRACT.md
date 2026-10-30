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

# Audit-trail contract (`audit-trail`)

Conformance clauses for the **hash-chained audit trail** that a Trajectory
runtime keeps per scope (workflow, instance, twin). The chain format is fixed
by design decision D7 of the ISA-113 twin-change design
(`2026-10-29-isa113-twin-change-design.md`); this document restates only what
a conformance check needs. Where the two disagree, the design document wins
and the fixture here is wrong.

Levels follow `contracts/README.md`: **MUST** fixtures gate the exit code.
Every fixture in this directory is MUST and cites its clause in `source` as
`C-AUD-<n>`.

Fixtures live in [`fixtures/`](fixtures/), one per file,
`aud-<nnn>-<slug>.json`. Trail inputs live in
[`fixtures/trails/`](fixtures/trails/), one NDJSON file per trail (§9).

## 1. Event shape

**C-AUD-1.** An audit event is a JSON object with at least `id` (string,
unique within the trail), `ts` (RFC 3339 UTC), `scope_id`, `kind`,
`payload` (object), `prev_hash`, `hash` and `signature`. Unknown fields are
permitted and are hashed like any other field.

**C-AUD-2.** Canonical form is RFC 8785 JCS. `hash` is the lowercase hex
SHA-256 of the JCS form of the event with `hash` and `signature` removed,
written either bare or as `sha256:<hex>`. A `recipe` field, when present,
names this recipe as `jcs-sha256`. Events whose JSON cannot be
canonicalized (non-finite numbers, lone surrogates, non-object events) are
not events: a verifier MUST reject the whole trail rather than report
issues on it.

## 2. Verification

A verifier walks the trail in order and reports **issues**, each
`{ index, id, issue }` where `index` is the 0-based position in the trail
and `issue` is one of the kinds below. Issues carry no payload values.

**C-AUD-3.** `altered` — the stored `hash` does not equal the recomputed
digest of the event's content. Every other event in the trail stays
verifiable; the issue lands only at the altered index.

**C-AUD-4.** `broken_link` — `prev_hash` does not equal the previous
event's `hash`. The genesis event (index 0) MUST carry `prev_hash: ""`;
any other value there is `bad_genesis`. Reordering events breaks the link
at the first displaced position and at every following position until the
chain realigns.

**C-AUD-5.** `duplicate_id` — the event's `id` was already seen earlier in
the trail. It is reported at the later occurrence.

**C-AUD-6.** `secret_in_payload` — some key at any depth of `payload`
matches `/(password|secret|token|api[_-]?key)/i` and holds a non-empty
string. The runtime MUST NOT write such payloads; a verifier flags them so
leaks surface in review. Neither the key nor the value appears in the issue
or in any runner report.

Within one event the report order is `altered`, then `bad_genesis` /
`broken_link`, then `duplicate_id`, then `secret_in_payload`. A verifier
that finds no issues reports an empty list.

| fixture | level | source | trail | expected issues |
|---|---|---|---|---|
| aud-001 | MUST | C-AUD-3 | `good` | none |
| aud-002 | MUST | C-AUD-3 | `payload-altered` | `altered` @2 |
| aud-003 | MUST | C-AUD-4 | `link-broken` | `broken_link` @4 |
| aud-004 | MUST | C-AUD-4 | `reordered` | `broken_link` @1, @2, @3 |
| aud-005 | MUST | C-AUD-5 | `duplicate-id` | `duplicate_id` @4 |
| aud-006 | MUST | C-AUD-6 | `secret` | `secret_in_payload` @3 |

## 3. Export

**C-AUD-7.** A runtime exposes its own trail for a scope as NDJSON
(`application/x-ndjson`): one event per line, chain order, no envelope. The
exported trail MUST verify clean under §2 with the verifier in this
repository (`contracts/runner/src/audit.mjs`), which is the reference
implementation of C-AUD-2..6.

**C-AUD-8.** Anyone holding an exported trail can verify it **offline** with
no access to the runtime: the runner's `--audit-file <path>` option reads a
local NDJSON file and exits `0` (no issues), `1` (issues reported) or `2`
(file unreadable, not NDJSON, or uncanonicalizable). The exit-2 case is
deliberate: a trail that cannot be hashed is not "clean", it is unverifiable.

| fixture | level | source | checks |
|---|---|---|---|
| aud-010 | MUST | C-AUD-3 | `GET /audit/export?scope_id=` is `application/x-ndjson` and verifies with no issues |

## 4. Conformance probe

The audit fixtures do not exercise the production surface at
`/trajectory/v1`; they exercise a **conformance probe** the target mounts
separately. A target declares it with the capability `audit_probe`, a
`probe_url` (the base of the probe, e.g. `…/conformance/v1`) and the role
`audit_scope` (a scope id whose trail the probe can export). Fixtures carry
`requires: ["audit_probe"]` and request steps marked `probe: true` are sent to
`probe_url` instead of `base_url`. Probe endpoints use the same `X-API-Key`
header and the REST error envelope (`docs/REST_Protocol.md` §1.3, §1.5).

**`POST {probe_url}/audit/verify`** — body `{ "events": [ … ] }`. Answers
`200 { "data": { "issues": [ … ], "events": <n> }, "meta": {} }` with the §2
issue list, or `400 VALIDATION_ERROR` when the body is not an object with an
`events` array or the trail cannot be canonicalized (C-AUD-2).

**`GET {probe_url}/audit/export?scope_id=<id>`** — answers `200` with
`content-type: application/x-ndjson` and the scope's trail, or
`400 VALIDATION_ERROR` when `scope_id` is missing.

Runner support used by these fixtures:

- `trail: "<path relative to contracts/>"` on a request step loads an NDJSON
  trail and sends it as `body.events`. The path must stay inside
  `contracts/`.
- `{ "kind": "audit_verify", "from": "<step id>" }` parses the named step's
  response text as NDJSON, runs the reference verifier and exposes
  `{ "issues": [ … ], "events": <n> }` to `expect.json`. An empty or
  unparseable export fails the fixture.

## 5. Trails

Trails in `fixtures/trails/` are generated by
`contracts/runner/test/audit-trails.mjs` from one five-event base trail
(`ev-001..ev-005`, scope `wf-4f1c`) hashed with the reference `jcs.mjs`;
each tampered variant edits the good trail *after* hashing, so the stored
hashes are honest and the tampering is what the verifier sees. The test
suite regenerates them and fails if the committed bytes drift.

| file | tampering | pinned issues |
|---|---|---|
| `good.jsonl` | none | — |
| `payload-altered.jsonl` | `payload` of ev-003 changed | `altered` @2 |
| `link-broken.jsonl` | `prev_hash` of ev-005 replaced | `broken_link` @4 |
| `reordered.jsonl` | ev-002 and ev-003 swapped | `broken_link` @1, @2, @3 |
| `duplicate-id.jsonl` | ev-005 re-hashed with id `ev-002` | `duplicate_id` @4 |
| `secret.jsonl` | ev-004 re-hashed with `payload.api_key` | `secret_in_payload` @3 |

The secret trail uses the obviously fake value
`not-a-real-secret-fixture-value`; the suite asserts it never appears in a
report or in `--audit-file` output.

## 6. Expected results against the toy

The in-process toy (`contracts/runner/test/toy-container.mjs`) mounts the
probe at `/conformance/v1` and exports a five-event chain for scope
`wf-toy-1`. With no defects every fixture passes: **7 pass, 0 fail, 0 note,
0 skip**, exit `0`. The `break-chain` defect corrupts `prev_hash` of the
toy's third exported event and fails exactly **aud-010**; the aud-001..006
fixtures verify the trails supplied by the fixture, not the toy's own, and
are unaffected.
