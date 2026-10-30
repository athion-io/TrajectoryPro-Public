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
runtime keeps per scope (workflow, instance, twin). The hash recipe is fixed
by the ISA-113 contracts plan, decision D7, restated in full under C-AUD-3
below so this document stands on its own. Where this document and the plan
disagree, the plan wins and the fixture here is wrong.

Levels follow `contracts/README.md`: **MUST** fixtures gate the exit code.
Every fixture in this directory is MUST and cites its clause in `source` as
`C-AUD-<n>`.

Fixtures live in [`fixtures/`](fixtures/), one per file,
`aud-<nnn>-<slug>.json`. Trail inputs live in
[`fixtures/trails/`](fixtures/trails/), one NDJSON file per trail (§5).
Golden canonical-form and hash vectors live in
[`fixtures/vectors/`](fixtures/vectors/) (§6).

## 1. Clauses

**C-AUD-1. Event fields.** An audit event is a JSON object with the fields
`id`, `ts`, `actor`, `action`, `scope_kind`, `scope_id`, `resource_type`,
`resource_id`, `rev`, `reason`, `payload`, `subject_hash`, `recipe`,
`prev_hash`, `hash` and `signature`. `payload` is an object. Unknown fields
are allowed and are included in the hash like any other field.

**C-AUD-2. Timestamp.** `ts` is ISO-8601 UTC with millisecond precision,
for example `2026-10-29T14:03:07.250Z`.

**C-AUD-3. Hash (D7).** Canonical form is RFC 8785 JCS. `hash` is the
SHA-256 of the JCS form of the event with `hash` and `signature` removed
(the event's *content hash*), rendered `sha256:<hex>` with lowercase hex;
a bare 64-character hex digest is accepted. A `recipe` field, when present,
names this recipe as `jcs-sha256`. A stored `hash` that does not equal the
recomputed content hash is the issue `altered`. Numbers are rendered as
RFC 8785 §3.2.2.3 says (the ECMAScript `Number::toString` form), including
values beyond 2^53: `1e+20` is `100000000000000000000`, `1e+21` is `1e+21`,
`-0` is `0`. Events whose JSON cannot be canonicalized (non-finite numbers,
lone surrogates, non-object events) are not events: a verifier MUST reject
the whole trail rather than report issues on it. The golden vectors in §6
are the shared truth for the canonical form and the digest; an
implementation whose canonicaliser disagrees with any of them does not meet
this clause.

**C-AUD-4. Chain.** `prev_hash` is the previous event's `hash`. The genesis
event (index 0) carries `prev_hash: ""`.

**C-AUD-5. Unique ids.** Event `id`s are unique within a trail.

**C-AUD-6. No secrets.** A runtime MUST NOT write secrets into `payload`:
no key at any depth matching `/(password|secret|token|api[_-]?key)/i` may
hold a non-empty string.

**C-AUD-7. Subject hash.** `subject_hash` is the content hash of the
artifact the event acted on (for example a change proposal's attested part),
computed with the C-AUD-3 recipe, so a trail proves *what* was approved and
not only that an approval happened. Which artifact is the subject is the
runtime's choice per action; the toy uses `sha256(JCS(payload))`, which is
one acceptable choice, not the definition.

**C-AUD-8. Action vocabulary.** The `action` vocabulary is open. These names
are RECOMMENDED so trails from different runtimes read alike: `run.started`,
`step.invoked`, `step.state`, `step.done`, `step.failed`, `command.sent`,
`command.refused`, `gate.opened`, `proposal.approved`, `run.completed`.

Only C-AUD-3..6 have fixtures. C-AUD-1, 2, 7 and 8 shape the trails the
fixtures carry and the toy exports, but no fixture fails a trail for a
missing field, a timestamp format, a subject hash or an action name.

## 2. Verification

A verifier walks the trail in order and reports **issues**, each
`{ index, id, issue }` where `index` is the 0-based position in the trail
and `issue` is one of the kinds below. Issues carry no payload values. The
verifier in this repository (`contracts/runner/src/audit.mjs`) is the
reference implementation of C-AUD-3..6.

- `altered` (C-AUD-3) — the stored `hash` does not equal the recomputed
  content hash. Every other event in the trail stays verifiable; the issue
  lands only at the altered index.
- `broken_link` (C-AUD-4) — `prev_hash` does not equal the previous event's
  `hash`. Reordering events breaks the link at the first displaced position
  and at every following position until the chain realigns.
- `bad_genesis` (C-AUD-4) — the event at index 0 carries anything other than
  `prev_hash: ""`.
- `duplicate_id` (C-AUD-5) — the event's `id` was already seen earlier in
  the trail. It is reported at the later occurrence.
- `secret_in_payload` (C-AUD-6) — a payload key matching the C-AUD-6 pattern
  holds a non-empty string. Neither the key nor the value appears in the
  issue or in any runner report; the verifier flags the leak so it surfaces
  in review.

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

## 3. Export and offline verification

A runtime exposes its own trail for a scope as NDJSON
(`application/x-ndjson`): one event per line, chain order, no envelope. The
exported trail MUST verify clean under §2; that is what aud-010 checks, and
its `source` is C-AUD-3 because a clean verification is the hash recipe
holding across the runtime's own events (with C-AUD-4..6 checked on the way).

Anyone holding an exported trail can verify it **offline** with no access to
the runtime: the runner's `--audit-file <path>` option reads a local NDJSON
file and exits `0` (no issues), `1` (issues reported) or `2` (file
unreadable, not NDJSON, or uncanonicalizable). The exit-2 case is deliberate:
a trail that cannot be hashed is not "clean", it is unverifiable. This is the
same verifier as the probe path, so a runtime without the probe can still be
checked from an export it hands over by other means.

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
`events` array or the trail cannot be canonicalized (C-AUD-3).

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

## 6. Golden vectors

`fixtures/vectors/audit-vectors.json` holds twelve vectors, each
`{name, input, canonical, hash}`, where `canonical` is the RFC 8785 form of
`input` and `hash` is `sha256:<hex>` of `canonical` as UTF-8. They were
generated by the Athion canonicalisation primitives (recipe
`athion-canon/2`, primitives commit
`c115860f6f1f75a270dc20181e0580f000fa3154`) and copied in unchanged; the
file's SHA-256 is
`0aa401b8322fa54aa29d13bafd819bfb1beef10845e5ecf48461953aaf43eaaa` and the
test suite checks it, so the file is never edited by hand. They cover key
order, non-ASCII keys, string escapes, numbers (large, small, `-0`), nested
arrays, empty payloads, and three linked events: a genesis event with
`prev_hash: ""` and two whose `prev_hash` is the hash of the one before.
The event inputs carry no `hash` or `signature`, so their `hash` is the
C-AUD-3 content hash of the whole input.

`contracts/runner/test/jcs.test.mjs` replays every vector through the
reference `jcs.mjs` and `audit.mjs` and requires an exact match of both the
canonical string and the digest. Another implementation can do the same
with its own canonicaliser; a mismatch on any vector means its hashes will
not verify here.

## 7. Expected results against the toy

The in-process toy (`contracts/runner/test/toy-container.mjs`) mounts the
probe at `/conformance/v1` and exports a five-event chain for scope
`wf-toy-1`. With no defects every fixture passes: **7 pass, 0 fail, 0 note,
0 skip**, exit `0`. The `break-chain` defect corrupts `prev_hash` of the
toy's third exported event and fails exactly **aud-010**; the aud-001..006
fixtures verify the trails supplied by the fixture, not the toy's own, and
are unaffected.
