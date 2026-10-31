# Trajectory Pro contracts

Executable contracts for the parts of Trajectory Pro that an implementation
other than the reference may provide: agent actions (and the outbound-only
relay), permissions, the audit trail, and configuration connectors.

Each contract is a `CONTRACT.md` with numbered clauses and a set of JSON
fixtures. A small, dependency-free Node runner plays the fixtures against any
implementation over HTTP and reports pass, fail, note or skip per fixture.

The contracts stand alone. They do not depend on Athion's stack or on the
reference Mission Autopilot container; both are just targets.

## The four contracts

| Directory | Contract | Clauses | Fixtures | How it is checked |
|---|---|---|---|---|
| `agent-action/` | An agent as a Trajectory action: auth, capabilities, invoke, instance view, commands and the state table, SSE, list and delete, CORS. §13 is the outbound-only relay variant (C-RLY). | `C-AGT-*`, `C-RLY-*` | `agt-*`, `rly-*` | The public REST surface under `/trajectory/v1` (`docs/REST_Protocol.md`). |
| `permission/` | Who and which agent may start or control a workflow or action. | `C-PRM-*` | `prm-*` | A probe surface the target exposes at `probe_url`, plus invoke responses. |
| `audit-trail/` | A tamper-evident record of every step, command and approval: hash-chained events, JCS (RFC 8785) canonical form, content hashes, no secrets in payloads. | `C-AUD-*` | `aud-*` | A probe surface at `probe_url`, and `--audit-file` for a trail on disk (offline, no network). Golden vectors in `audit-trail/fixtures/vectors/`. |
| `config-connector/` | Patch a vendor configuration file and prove it by read-back. One shape for any vendor. | `C-CFG-*` | `cfg-*` | A probe surface at `probe_url`. The `cfg-100..103` fixtures are tagged `live` and run only against a target with `live_vendor: true`. |

Each `CONTRACT.md` ends with the results expected against the reference toy.
`HARDENING.md` lists what was found in the reference code while writing the
contracts, with severities and open questions. `REUSE-REPORT.md` sorts the
reference code into reusable as-is and example only.

## Levels

Every fixture has a `level`. MUST and SHOULD fixtures cite the clause they
check in `source`.

| Level | Meaning | Effect on the exit code |
|---|---|---|
| `MUST` | Required. A failure means the target does not conform. | A failed MUST gives exit code 1. |
| `SHOULD` | Recommended. A failure is reported as a `note` ("SHOULD not met"). | None. |
| `IMPL-DEFINED` | The contract allows more than one behaviour; the fixture records which one the target has. A failure stays `fail` in the report. | None. |
| `EXTENSION:<name>` | Runs only when the target lists `<name>` in `extensions`. The fixture also lists the name in `requires`. A failure stays `fail` in the report. | None. |

Current extensions are `change-guard` and `forwarded-identity`, both in
`agent-action/CONTRACT.md` §12.

## Outcomes

| Outcome | When |
|---|---|
| `pass` | Every step passed and nothing was noted. |
| `fail` | A check did not hold. For MUST this is a conformance failure. |
| `note` | Something to read, not a failure: a SHOULD not met; a failure listed in the target's `known_failures` (reason `known: …`); a step that recorded a note; or a fixture that only has an `attests` clause, which the target attests to in `attestations` (such fixtures are never `pass`). |
| `skip` | The fixture could not run against this target: a `requires` entry is not in the target's capabilities, extensions or roles; the fixture needs a user token the runner was not given; the fixture is tagged `live` and the target has no `live_vendor: true`; the fixture's `attests` clause is not attested; or a non-MUST fixture's setup failed with `tolerate: true`. The reason names the first missing requirement. |

## Running the runner

Needs Node 20 or later and nothing else. `runner/package.json` declares
`engines.node >=20`; the runner uses only `fetch`, `node:crypto`,
`util.parseArgs` and `structuredClone` from Node itself (verified on 20, 22
and 24). Running the runner's own unit tests needs Node 22 or later; see
"Unit tests". There is no `npm install` and no `node_modules`.

From the `contracts/` directory, with a target profile you have written
(see "Writing a target"; `targets/toy.target.json` is the example profile
and only resolves inside the unit tests):

```
node runner/bin/trajectory-contracts.mjs --target targets/<your-target>.target.json --report report.json
```

Fixtures are found relative to the runner's own location, so the command
also works from any other directory as long as `--target` points at the
file.

| Flag | What it does |
|---|---|
| `--target <file>` | The target profile (required unless `--audit-file`). |
| `--suite <a,b>` | Categories to run: `agent-action`, `permission`, `audit-trail`, `config-connector`. Default: every category that has a `fixtures/` directory. |
| `--only <id[,id]>` | Run only these `test_id`s, for example `--only agt-001,agt-002`. |
| `--report <out.json>` | Write the JSON report here. |
| `--audit-file <file>` | Verify a local NDJSON audit trail offline. Cannot be combined with the flags above. |
| `--help` | Print usage. |

| Exit code | `--target` | `--audit-file` |
|---|---|---|
| 0 | No MUST fixture failed. | The trail is clean. |
| 1 | A MUST fixture failed. | Issues were found. |
| 2 | Usage, lint or target error. | The file is unreadable or not canonicalizable. |

Secrets are never read from a target file. They come from the environment:

| Variable | Used for |
|---|---|
| `CONTRACTS_API_KEY` | Sent as the target's auth header (`auth.header`, default `X-API-Key`). Required when the target has `auth.mode: "required"`. The runner does not follow redirects, so the key goes only to `base_url` or `probe_url`; over plain `http://` it is sent unencrypted, so use `https://` for anything not on this machine. |
| `CONTRACTS_USER_TOKEN` | `forwarded-identity` user token with the grant (`{{user_token}}`). |
| `CONTRACTS_UNGRANTED_USER_TOKEN` | A valid user token without the grant (`{{ungranted_user_token}}`). |

Fixtures that need a token the runner was not given skip. Reports redact
`X-API-Key`, `Authorization`, `X-Trajectory-User` and any `token=` query
value.

### Console and report

Each fixture prints one line, `<outcome> <test_id> <level> - <reason>`, then
a summary `<target>: N pass, N fail, N note, N skip`. With `--report` the
file holds:

```json
{
  "target": "toy",
  "runner_version": "0.1.0",
  "fixtures_commit": "<git HEAD of this checkout, or \"unknown\">",
  "started_at": "<ISO-8601>",
  "totals": { "pass": 0, "fail": 0, "note": 0, "skip": 0 },
  "results": [
    { "test_id": "agt-001", "level": "MUST", "outcome": "pass", "reason": "…", "evidence": [ ] }
  ]
}
```

### Checking an audit trail offline

```
node runner/bin/trajectory-contracts.mjs --audit-file trail.jsonl
```

Reads one JSON event per line and checks the hash chain (C-AUD-3..6). Issues
name the event index and kind (`altered`, `broken_link`, `bad_genesis`,
`duplicate_id`, `secret_in_payload`) and never print payload values.

### Unit tests

```
cd runner
node --test "test/**/*.test.mjs"
```

This needs Node 22 or later: the glob argument to `node --test` is not
understood by Node 20 (verified on 22 and 24). The tests use an in-process reference toy (`runner/test/toy-container.mjs`)
with an injected `fetch` and clock. They open no sockets and start no
timers. `targets/toy.target.json` names the host `toy.test`, which exists
only inside those tests.

## Writing a target

A target is a JSON file that says where an implementation is and what it
supports. The schema is `schema/target-schema.json`;
`targets/toy.target.json` is a complete example.

| Key | Required | Meaning |
|---|---|---|
| `name` | yes | Short name, printed in the summary and report. |
| `base_url` | yes | The `/trajectory/v1` base, an `http://` or `https://` URL, for example `http://localhost:3002/trajectory/v1`. |
| `auth` | yes | `{ "mode": "none" }` or `{ "mode": "required", "header": "X-API-Key", "scheme": "" }`. `header` defaults to `X-API-Key`; a non-empty `scheme` is put in front of the key. |
| `capabilities` | yes | What the target supports; see below. |
| `roles` | yes | Named identifiers the fixtures use through `{{roles.<name>}}`. `environment_oid` is always required. |
| `probe_url` | with any `*_probe` capability | Base of the probe surface, for example `http://localhost:3002/conformance/v1`. |
| `extensions` | no | Extension names the target implements. |
| `timeouts` | no | `wait_s` and `sse_s` in seconds; both default to 15. |
| `known_failures` | no | `{ "<test_id>": "<reason>" }`. A failure listed here is reported as `note`, not `fail`. |
| `attestations` | no | `{ "<clause>": true }` for clauses the runner cannot observe, such as `C-RLY-4`. |
| `live_vendor` | no | `true` lets the `live`-tagged connector fixtures run. |

Capabilities: `observable_action`, `opaque_action`, `commands`, `sse`,
`list`, `delete`, `cors`, `outbound_only`, `permission_probe`,
`audit_probe`, `connector_probe`.

Some capabilities require roles:

| Capability | Role it needs |
|---|---|
| `observable_action` or `sse` | `observable_action` |
| `opaque_action` | `opaque_action` |
| `cors` | `cors_origin` |
| `audit_probe` | `audit_scope` |

Fixtures may also require roles directly, such as `fast_action`,
`offline_action`, `unknown_action`, `guarded_action` and
`guarded_change_hash`. A fixture whose `requires` names a role the target
does not have skips. The toy target has all of these except
`guarded_change_hash`, which only `agt-062` (`EXTENSION:change-guard`)
needs, so that fixture skips against the toy.

Lint errors in a target (missing keys, an unknown capability, a probe
capability without `probe_url`) stop the run with exit code 2.

## Running against the reference Mission Autopilot

The runner only connects. The container is started separately, by Marsha,
from the repository root:

```
sh scripts/setup-secrets.sh
docker compose up -d mission-autopilot-server
```

`setup-secrets.sh` writes `.env` files with `ACTIONS_API_KEY` among other
keys (`POSTGRES_PASSWORD` and the internal service tokens). The service is `mission-autopilot-server`; it listens
on `127.0.0.1:3002`, so `base_url` is `http://localhost:3002/trajectory/v1`.
Its `auth.mode` is `required`; set `CONTRACTS_API_KEY` to the same value as
the container's `ACTIONS_API_KEY` before running. Never put the value in the
target file.

The reference container has no probe surface, so its target lists no
`*_probe` capability and the permission, audit-trail and connector probe
fixtures skip. The target file and the first results
(`targets/autopilot-reference.target.json`, `HARDENING.md` finding 12) are
not in this tree yet; see `HANDOFF.md`.

## Layout

| Path | What it holds |
|---|---|
| `agent-action/`, `permission/`, `audit-trail/`, `config-connector/` | One `CONTRACT.md` and a `fixtures/` directory each |
| `audit-trail/fixtures/vectors/` | Golden JCS and hash vectors |
| `schema/contract-fixture-schema.json` | JSON Schema for a fixture |
| `schema/target-schema.json` | JSON Schema for a target profile |
| `targets/` | Target profiles (`toy.target.json`, `athion-door.target.json`) |
| `results/` | Recorded reports, one per run, named `<target>-<commit>.json` |
| `runner/` | The runner: `bin/trajectory-contracts.mjs`, `src/`, `test/` |
| `HARDENING.md` | Findings in the reference code, severities, open questions |
| `REUSE-REPORT.md` | What in the reference code is reusable as-is |
| `HANDOFF.md` | Status, squash recipe and open questions for Marsha |

## Licence

Copyright 2026 Athion, Inc. Licensed under the Apache License, Version 2.0.
