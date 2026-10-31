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

# Handoff: Trajectory contracts and conformance runner

For Marsha. What is in this folder, how to turn it into one public commit,
and what still needs a decision before anything goes to Dennis.

## What this is

Four executable contracts (agent action, permission, audit trail, config
connector), their JSON fixtures, a zero-dependency Node runner, a reference
toy used by the runner's tests, `HARDENING.md` and `REUSE-REPORT.md`. The
plan is `2026-10-29-isa113-contracts.md`; the design is
`2026-10-29-isa113-twin-change-design.md`. `README.md` explains how to run
it.

Everything lives under `contracts/`. Nothing outside `contracts/` changed on
this branch. No pull request has been opened anywhere.

## Status by task

| Task | What | Where | State |
|---|---|---|---|
| 1–11 | Runner, schemas, four contracts and fixtures, reference toy, HARDENING, REUSE-REPORT | this branch | done |
| 12 | Golden JCS and hash vectors from primitives | athion-io/athion-apps-sidecar, branch `mfwisely-wisetech-isa113-contracts-proof` | done; vectors copied to `audit-trail/fixtures/vectors/` |
| 13 | Node cross-check of the golden vectors | this branch | done |
| 14 | Door target and CI proof (pins this branch at `90af2462`) | athion-io/athion-apps-sidecar, same branch | done; recorded here as `targets/athion-door.target.json` and `results/athion-door-83b0fd24.json` (see below) |
| 15 | HARDENING.md | this branch | done |
| 16 | REUSE-REPORT.md | this branch | done |
| 17 | README.md and this file | this branch | done |
| 18 | Baseline run against the reference Mission Autopilot container | this branch | blocked until someone starts the container; `HARDENING.md` finding 12 is the placeholder |

Recorded results. `results/athion-door-83b0fd24.json` is the report
artifact of the "contracts proof" CI run 41156346231 on the sidecar branch
above at commit `83b0fd24`, copied byte for byte. That run checked the
fixtures at `90af2462` (the report's `fixtures_commit`), not this branch's
head; no fixture, schema or runner code has changed since (only docs, tests and
the `engines` field of `runner/package.json`). Totals: 62
pass, 0 fail, 2 note, 10 skip. `targets/athion-door.target.json` is that
commit's `services/trajectory-door/contracts/athion-door.target.json`, also
byte for byte. `runner/test/recorded.test.mjs` checks that every target
loads and every results file is a complete report with no failures.

Task 18 needs `targets/autopilot-reference.target.json` and a results file;
neither exists yet. The README says how the container is started
(`sh scripts/setup-secrets.sh`, then `docker compose up -d
mission-autopilot-server`; REST on `http://localhost:3002`). The runner only
connects.

## Decisions you made on 2026-10-29

| Topic | Decision |
|---|---|
| Number rendering in JCS | Keep RFC 8785 rendering as is; no throw above 2^53. |
| HARDENING finding 11 (primitives vs JCS canonicalisation) | Severity L. |
| HARDENING finding 13 (Mission Broker `Authorization` only) | Severity M. |

## One-commit squash

Dennis receives a single commit through you. This creates a branch off
`main` with the `contracts/` tree from this branch, as one commit:

```
git checkout -b contracts-squash main && git checkout mfwisely-wisetech-isa113-contracts -- contracts && git commit -m "Add Trajectory contracts and conformance runner"
```

Why it works: `main` has nothing under `contracts/` (`git ls-tree main
contracts` prints nothing), and `git checkout <branch> -- contracts` both
writes the files and stages them, so `git commit` needs no `git add`. The
runner's `.gitignore` is a tracked file and comes along.

Check before you run it:

```
git diff --stat main...mfwisely-wisetech-isa113-contracts
```

Every line should be under `contracts/`. After the commit, `git show --stat
HEAD` on `contracts-squash` should list the same files.

The commit message does not carry a Co-authored-by trailer; add one if you
want it on the public commit.

## In scope

- The four contracts and their fixtures, with levels (`MUST`, `SHOULD`,
  `IMPL-DEFINED`, `EXTENSION:<name>`) and outcomes (`pass`, `fail`,
  `note`, `skip`).
- A runner that reaches implementations over HTTP only, reads secrets from
  the environment only, and redacts them in reports. Offline audit-trail
  verification with `--audit-file`.
- A target profile per implementation (`targets/`), with `known_failures`
  and `attestations` so a non-Athion implementation can pass honestly where
  REST_Protocol leaves room.
- The optional probe surface `/conformance/v1/*` for permission, audit and
  connector checks, which are not on Dennis's REST surface.
- Hardening findings on the reference code, with severities, and a reuse
  report.

## Out of scope

- Any change outside `contracts/`, including Dennis's vendored
  `MissionEngine/src/conformance/`.
- Athion's door, workflow runner and probe implementation. Those are in
  athion-io/athion-apps-sidecar (Tasks 12 and 14).
- Live vendor routes (DeltaV, Mimic). See below.
- The baseline run against the reference container (Task 18).
- Starting any server from the runner or its tests. The toy is in-process;
  real targets are started by you.

## Open questions for Dennis

These five are the ones the plan asks you to put to him. `HARDENING.md`,
section "Open questions for Dennis", has the full list of thirteen with the
clause each one points at; the rest are not repeated here.

| Id | Question | Where |
|---|---|---|
| D8 | A command that is invalid in the current state: `409 INSTANCE_ERROR` (Athion), `409 INVALID_STATE_TRANSITION` (what the reference ships), or 5xx (what the document says)? The fixture accepts 409 or 5xx and records a `note`. | HARDENING finding 4 and open question 8; `agent-action/CONTRACT.md` §7 |
| D9 | Invoke idempotency. The base contract says nothing (`IMPL-DEFINED`); the outbound-only variant makes it `SHOULD`. HARDENING proposes an optional `Idempotency-Key` header for v1.1: name and retention window. | HARDENING finding 5 and open question 12; `agent-action/CONTRACT.md` §5 and §13 |
| D10 | Header name for the forwarded user identity. `X-API-Key` is the contract. The `forwarded-identity` extension proposes `X-Trajectory-User` next to it. Is that the name, and is a bearer-style value right? | HARDENING finding 6 and open question 1; `agent-action/CONTRACT.md` §12 |
| D11 | First SSE frame `previous_state: null`. REST says `null`; the door sends the real previous state. The fixture accepts either (`IMPL-DEFINED`). Keep as informative or drop? | HARDENING finding 7 and open question 11; `agent-action/CONTRACT.md` §8 |
| Probe prefix | Permission, audit and connector are checked through `/conformance/v1/*`, following his own `/management/v1` precedent for the test harness. Offer the prefix to him for the reference container, or keep it Athion-side only? | plan D6; `permission/`, `audit-trail/` and `config-connector/` CONTRACT.md |

## Licence and copyright (D12)

The contracts, the runner's source and test files, the schemas, the reports
and this file carry the Apache-2.0 header `Copyright 2026 Athion, Inc.`,
matching Dennis's licence. The JSON fixtures, the toy target and
`package.json` (`"license": "Apache-2.0"`) carry no header. Whether to keep
that copyright line, assign it, or change it before the public commit is
your decision. Nothing has been sent.

## Live-vendor fixtures wait on plan 4 (D13)

`config-connector/fixtures/cfg-100` to `cfg-103` use real DeltaV FHX and
Mimic XML routes. They are tagged `live` and skip unless a target sets
`live_vendor: true`. Their `source` body shape, route names and placeholder
item are provisional until plan 4 (Skytap) verifies the routes. HARDENING
open question 6 records this. Do not treat them as settled.

## What is not verified in this tree

- The door results were not re-run from this tree. They are the sidecar
  CI's report, produced against the fixtures at `90af2462`.
- Task 18's reference-container results. The container has not been started
  for this work.
- Nothing about Node versions beyond this: the runner (`bin` and `src`)
  works on Node 20, 22 and 24 and declares `engines.node >=20`; its unit
  tests (`node --test "test/**/*.test.mjs"`) need Node 22 or later because
  Node 20's `--test` does not take a glob. Verified on 22 and 24.
