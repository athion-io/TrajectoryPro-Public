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

# Reuse report

This report sorts the TrajectoryPro-Public code base, as written by Dennis L.
Brandl (Apache-2.0, © 2026 Dennis L. Brandl), into what Athion or a third
party can depend on unchanged behind the contracts in this folder, and what
is there to show how the pieces fit together. It was produced by reading the
tree at commit `20c12ab`; nothing was run or changed. Line numbers are as of
that commit and will drift.

## Verdicts

- **Reusable as-is** — code (or a document) that another party can depend on
  without changing it, behind the contracts in this folder. Where a
  hardening finding applies, the finding number from
  [HARDENING.md](HARDENING.md) is given.
- **Example only** — screens, styling, demo data and samples. Useful to read
  and to copy from; not something to take a dependency on.

The starting verdicts were set by Marsha Wisely; this report confirms each
one by reading the entry points and says explicitly where the reading
changed a verdict (one row: Mission Broker).

## How the sizes were counted

File and line counts are for the tree at `20c12ab`, from
`git ls-tree -r --name-only 20c12ab` (the same file set `git ls-files`
gives at that commit) with each blob read through `git cat-file --batch`.
Lines are the number of newline characters, plus one when the last line has
no trailing newline. A file with a NUL byte in its first 8000 bytes is
counted as binary: it adds to the file count and contributes zero lines.
Counts include tests, fixtures, generated migration snapshots and
documentation inside each directory — they measure how much is there, not
how much is hand-written. Where the distinction matters it is called out.

Whole tree: 2 738 files, 615 225 lines, 72 binary files.

| Top-level directory | Files | Lines | Binary |
|---|---:|---:|---:|
| `MissionDesigner/` | 1 041 | 195 081 | 33 |
| `MissionCommander/` | 418 | 52 727 | 16 |
| `MissionAutopilot/` | 315 | 63 757 | 4 |
| `mission-control-db/` | 293 | 182 201 | 0 |
| `MissionEngine/` | 237 | 57 651 | 0 |
| `MissionFormKit/` | 137 | 16 597 | 6 |
| `MissionPilot/` | 128 | 23 898 | 2 |
| `MissionAutopilotTester/` | 119 | 15 434 | 6 |
| `MissionBroker/` | 33 | 4 284 | 3 |
| `docs/` | 4 | 2 442 | 1 |

`mission-control-db/` is dominated by Drizzle migration snapshots
(`drizzle/meta/`, 46 files, 148 657 lines); the hand-written source under
`src/` is 179 files, 27 815 lines.

## Where the roles come from

Only `MissionAutopilot`, `MissionAutopilotTester`, `MissionDesigner` and
`MissionFormKit` have their own `README.md` at `20c12ab`. `MissionBroker`,
`MissionCommander`, `MissionEngine`, `MissionPilot` and `mission-control-db`
do not; their role below is quoted from the applications table in the root
`README.md`, and the row says so.

## Summary table

| Area | Size (files / lines) | Verdict |
|---|---|---|
| `docs/REST_Protocol.md`, `docs/JSON_SCHEMA.md` | 2 / 1 558 | Reusable as-is |
| `MissionEngine` core + spec validator + conformance harness and fixtures | 237 / 57 651 (core 27 / 10 612; spec 4 / 2 436; conformance 95 / 7 613) | Reusable as-is |
| `mission-control-db` schema, DAOs, control grants | 293 / 182 201 (src 179 / 27 815) | Reusable as-is, behind the permission contract |
| `MissionAutopilot/packages/server` + `packages/engine` | 77 / 24 207 | Reusable as-is for protocol and state machine; findings 1, 2, 10 apply |
| `MissionAutopilot/apps/console` | 94 / 11 274 | Example only |
| `MissionBroker` | 33 / 4 284 | Reusable as-is for the distributed-workflow actions, **with a caveat on the auth header** (verdict adjusted — see row) |
| `MissionCommander` server routes | 85 / 9 947 | Reusable with hardening (finding 6) |
| `MissionCommander` UI, `MissionPilot`, `MissionDesigner` app shell, `MissionDesigner/packages/tokens` | 197 / 23 396; 128 / 23 898; 1 041 / 195 081; 14 / 226 | Example only |
| `MissionFormKit` schema; renderer | schema 35 / 2 972; renderer 46 / 3 307 | Reusable as-is (schema); example (renderer) |
| `MissionAutopilotTester` | 119 / 15 434 | Example only; superseded for conformance by `contracts/runner` |
| Samples, test data, seeds, Kitchen/Warehouse libraries | see row | Example only (demo data) |

## Rows

### `docs/REST_Protocol.md`, `docs/JSON_SCHEMA.md` — Reusable as-is

- **Role.** `REST_Protocol.md` (687 lines): "the **public** REST surface
  served by a Trajectory Action Container at `/trajectory/v1/*` and consumed
  by a Trajectory Runtime" (its Scope paragraph). `JSON_SCHEMA.md` (871
  lines): "the complete JSON object schemas the Trajectory product family
  exchanges and ... the ZIP bundle layouts that carry them" (its Scope
  paragraph).
- **Evidence.** The contracts in this folder cite `REST_Protocol.md` by
  section (`contracts/agent-action/CONTRACT.md` alone references it eight
  times, e.g. C-AGT-3 "REST §1.3"); every MUST in the agent-action contract
  is anchored to a paragraph of it.
- **Caveat, not a verdict change.** `JSON_SCHEMA.md` opens with a banner
  saying its tool attributions (Trajectory Editor, Runtime, Action
  Container) are stale after the 2026-09-09 rebrand and "the FORMAT
  definitions below ... remain authoritative". Depend on the formats, not on
  the producer/consumer tables. The findings in `HARDENING.md` are changes
  we think the REST document should take; until they land, the document is
  the standard and the findings are the delta.
- The third file, `docs/DISTRIBUTED_WORKFLOW_LIBRARY.md` (346 lines, plus a
  PDF copy), is a user guide for the Broker's action library, not a
  protocol; it is read with the Broker row.

### `MissionEngine` core, spec validator, conformance harness and fixtures — Reusable as-is

- **Role.** No `README.md` of its own. Root README: "Executes runtime
  workflows against the shared database and dispatches environment actions;
  its image also serves Mission Pilot".
- **Paths.** `src/core/` (27 files, 10 612 lines), `src/spec/validator.ts`
  (926 lines) with `src/spec/workflow-schema.json`, `src/conformance/`
  (95 files, 7 613 lines; `harness.ts` 195 lines and the vendored
  fixtures). `src/actions/client.ts` is the REST client the engine uses to
  call action servers.
- **Evidence for "79/0/3 baseline per PROVENANCE".** Found.
  `src/conformance/PROVENANCE.md:42` records "79 passed / 0 failed / 3
  skipped across all 82 fixtures"; the three skipped are the `exec-child-*`
  fixtures. `PROVENANCE.md:3` states the fixtures are vendored from an
  external reference repository and "must not be edited in place" — which
  is also why this folder never touches `MissionEngine/src/conformance/`.
- **What that baseline covers.** The conformance fixtures exercise the
  *workflow engine* — spec validation, execution, parameters, resources —
  not the REST action protocol. `contracts/runner` covers the protocol
  surface; the two do not overlap, and neither replaces the other.
- **Dependency note.** The engine is built on `mission-control-db` (shared
  Postgres schema); it is reusable as-is as a runtime, not as a standalone
  library.

### `mission-control-db` schema, DAOs, control grants — Reusable as-is, behind the permission contract

- **Role.** No `README.md` of its own. Root README: "Shared Postgres schema,
  migrations, and data access used by Mission Commander and Mission Engine".
- **Paths.** `src/db/schema/` (schema, 34 files / 2 357 lines under
  `src/db/`), `src/dao/` (70 files, 12 487 lines), `src/runtime/` (37 files,
  5 725 lines), `drizzle/` migrations.
- **Evidence for "grants `own`/`any` map to C-PRM-2".** Found.
  `src/db/schema/control-grants.ts` defines
  `CONTROL_GRANT_SCOPES = ['own', 'any']` and the table
  `work_center_control_grant` carries a database check
  `scope in ('own','any')`. `src/dao/control-grants.ts` exports
  `listControlGrants`, `setControlGrant`, `deleteControlGrant` and
  `getControlGrantScope`. `contracts/permission/CONTRACT.md:171` (C-PRM-2)
  states the control-grant rule and probes prm-005..007 walk the
  `own`/`any` matrix (`GRANT_SCOPE_OWN` at line 124).
- **Also here.** `src/dao/access.ts` holds the guarded access-level changes
  ("no self-demote, never zero active admins", its doc comments) that the
  Commander routes call into; the permission logic lives in the DAO layer,
  which is what makes it reusable behind the contract rather than tied to
  one UI.
- **Size caveat.** 149 871 of the 182 201 lines are generated Drizzle
  migration snapshots.

### `MissionAutopilot/packages/server` + `packages/engine` — Reusable as-is for protocol and state machine; findings 1, 2, 10 apply

- **Role.** From `MissionAutopilot/README.md`: "Hosts and executes
  Trajectory actions. A TypeScript monorepo — `apps/console` (management
  UI), `packages/server` (Trajectory REST protocol + management API),
  `packages/engine` (action state machine), `packages/storage` — with a
  Python sidecar that runs action code."
- **Paths.** `packages/server/` (48 files, 16 086 lines): Express 5 app in
  `src/index.ts` mounting `routes/protocol.ts` (`/health` :137,
  `/capabilities` :151, `POST /actions/:action_oid/invoke` :207,
  `GET /instances/:id` :262, `GET /instances` :289, properties :325–411,
  `DELETE /instances/:id` :493) and `routes/commands.ts`
  (`POST /instances/:id/command` :44, `GET /instances/:id/events` :108),
  behind `middleware/auth.ts` (API key) and `middleware/host-check.ts`.
  `packages/engine/` (29 files, 8 121 lines): `src/index.ts` exports
  `StateMachine`, `InstanceManager`, `PythonWorkerPool` and the error
  types; `state-machine/states.ts` (observable states incl. `EXECUTING`,
  `HELD`, `COMPLETED`, `ABORTED`; `OpaqueState` at :39) and
  `state-machine/transitions.ts` (167 lines, builds the table "per
  StateMachineSpec.md §2"). The specs themselves are in
  `.MissionAutopilot/*.md` (10 files).
- **Evidence.** This is the reference container the agent-action contract
  was written against; the route set above is the `/trajectory/v1/*`
  surface `REST_Protocol.md` defines.
- **How the findings land here.** Findings 1 (open access) and 2 (CORS)
  are already *met by this code* at `20c12ab` — it refuses to boot without
  a 32-character `ACTIONS_API_KEY` and keeps a CORS allowlist — and target
  the protocol document, which does not yet require either. Finding 10
  (`expose_traceback`) is a reservation: the flag is noted in
  `routes/protocol.ts:129` but not implemented. Findings 4 and 9 are
  code-versus-document naming (the code answers 409
  `INVALID_STATE_TRANSITION` where the document says `INSTANCE_ERROR`).
  None of these stop a party depending on the server unchanged.
- **Coupling.** `packages/engine` bundles the Python worker pool
  (`python-pool/worker.ts:56` spawns `python -u sandbox_runner.py`), so the
  engine package is reusable with `packages/python-sidecar/` (3 files,
  1 170 lines) alongside it, not on its own.

### `MissionAutopilot/apps/console` — Example only

- **Paths.** `apps/console/` (94 files, 11 274 lines), React 19.
- **Evidence.** `apps/console/package.json` depends on `@mission/tokens` and
  `@mission/ui` by relative path into `MissionDesigner/packages/`; it is the
  management UI over the server's private `/management/v1/*` routes, which
  `REST_Protocol.md` explicitly excludes from the public surface. Screens.

### `MissionBroker` — Reusable as-is for the distributed-workflow actions, with a caveat on the auth header (verdict adjusted)

- **Role.** No `README.md` of its own. Root README: "Action server for the
  Distributed Workflow actions: lets a running workflow create, start,
  control and wait for other runtime workflows". User guide in
  `docs/DISTRIBUTED_WORKFLOW_LIBRARY.md`; the action library bundle is in
  `designer-library/` (4 files, 3 binary).
- **Paths.** Hono app in `src/app.ts` (11 source files, 736 lines; 9 test
  files, 809 lines) serving `/health`, `/trajectory/v1/capabilities`,
  `POST /trajectory/v1/actions/:oid/invoke`,
  `GET`/`DELETE /trajectory/v1/instances/:id`, `POST .../command`,
  `GET .../events`, with `{ error: { code, message } }` envelopes
  (`VALIDATION_ERROR`, `FORBIDDEN`, `ACTION_NOT_FOUND`,
  `INSTANCE_NOT_FOUND`, 409 `INVALID_STATE_TRANSITION`).
- **Why the starting verdict holds for the actions.** The route set and the
  error envelope match the protocol shape; the actions it offers are the
  only implementation of distributed workflows in the tree, and
  `MissionEngine/src/actions/client.ts` is written to call it.
- **Why the verdict is qualified — evidence.** `src/auth.ts` `brokerAuth`
  accepts **only** `Authorization: Bearer <token>` (and `?token=` on the
  events path) and answers 401 with `{ error: BROKER_TOKEN_ERROR }` — a
  string, not the `{ error: { code, message } }` envelope. The engine
  knows this: `MissionEngine/src/actions/client.ts:240-241` deliberately
  sends `Authorization: Bearer` to the broker origin and `X-API-Key` to
  the actions origin. `contracts/agent-action/CONTRACT.md:58-61` (C-AGT-3,
  REST §1.3) requires `X-API-Key` and says a request carrying only
  `Authorization: Bearer` MUST NOT be authenticated (probe agt-003). As
  written, the Broker would fail agt-003 and, unless the target profile
  names `Authorization`, agt-002. This is the same shape as finding 3,
  which `HARDENING.md` records only for the Tester; the Broker is not in
  `HARDENING.md` today. That is an open question for the hardening list,
  not something this report settles.
- **Coupling.** `package.json` depends on `mission-control-db` by relative
  path (`file:../mission-control-db`), imports its schema and
  `runtime/remote-control`, and `src/index.ts:50-66` runs
  `LISTEN engine_wake` on the engine's Postgres wake channel. It is reusable as-is as a companion to the engine and shared
  database, not as a standalone action server.

### `MissionCommander` server routes — Reusable with hardening (finding 6)

- **Role.** No `README.md` of its own. Root README: "Work centers, users
  and roles, loaded packages, and the creation and control of runtime
  workflows".
- **Paths.** `src/server/` (85 files, 9 947 lines): `app.ts` mounts
  better-auth at `/api/auth/*` behind `clientIpMiddleware`, `signupGate`
  and `adminGate` (:83–85, handler at :86), then sixteen route modules under `/api`
  (`routes/me.ts`, `work-centers.ts`, `workflows.ts`,
  `runtime-workflows.ts`, `runtime-history.ts`, `environment-bindings.ts`,
  `control-grants.ts`, `environments.ts`, `load.ts`, `pickers.ts`,
  `users.ts`, `roles.ts`, `allowed-roles.ts`, `package.ts`,
  `system-settings.ts`, `brand-assets.ts`). `lib/auth.ts` configures
  better-auth with the admin plugin; the comment there says
  "Authorization rides `app_user.role`, which is a pure MIRROR of
  `access_level` (dao/access.ts setAccessLevel)".
- **Evidence.** Routes guard with `requirePermission('work_center:read')`
  and the like and pass `c.get('principal').userId` into the
  `mission-control-db` DAOs (`routes/runtime-workflows.ts`), so the
  permission decisions are in the shared DAO layer and the routes are the
  HTTP face of them. Finding 6 (per-app sign-in: `app.ts:86`,
  `src/routes/login.tsx`) is why this is "with hardening" rather than
  "as-is": the sign-in is Commander's own, and a party reusing the routes
  inherits that until the finding lands.

### `MissionCommander` UI, `MissionPilot`, `MissionDesigner` app shell, `MissionDesigner/packages/tokens` — Example only

- **Commander UI.** `MissionCommander/src/components/` (197 files, 23 396
  lines) and `src/routes/` (10 files, 710 lines): React screens over the
  routes above.
- **Mission Pilot.** No `README.md` of its own. Root README: "Operator task
  inbox, installable as a PWA: claim, submit, and release workflow steps".
  `src/` 113 files, 15 826 lines, of which `src/screens/` is 22 files,
  6 238 lines; `src/api/client.ts` and `src/host/gate.ts` are the thin
  runtime-facing pieces. A PWA front end; the behaviour it shows lives in
  the engine and the database.
- **Mission Designer.** From its `README.md`: "Visual editor for authoring
  distributed-workflow packages ... React + Vite, Hono API server,
  PostgreSQL (Drizzle)". 1 041 files, 195 081 lines — the largest app.
  `src/server/` (200 files, 33 583 lines) has its own sign-in
  (`src/server/index.ts:152`, finding 6) and its own DAO/db layers
  (`src/server/dao`, `src/server/db`) separate from `mission-control-db`;
  `src/lib/` (209 files, 31 096 lines) holds the editor's import/export and
  package-format code. The package *format* it writes is the reusable thing
  and is specified in `docs/JSON_SCHEMA.md`, which is why the editor itself
  is example: an alternative editor targets the document, not this code.
- **`MissionDesigner/packages/tokens`** (14 files, 226 lines) is design
  tokens — styling — and `packages/ui` (15 files, 1 122 lines) is the
  shared component kit the console also imports. Styling.

### `MissionFormKit` — Reusable as-is (schema); renderer example

- **Role.** From its `README.md`: "Shared form document schema, tokens, and
  renderer for Mission Designer and the Trajectory runtime display
  applications ('one renderer, two modes')".
- **Schema — reusable.** `packages/form-schema/` (35 files, 2 972 lines).
  The README calls it "formDocument v2 types, JSON Schema, validator,
  breakpoint cascade. **React-free.**" Its `package.json` depends only on
  `ajv` and `ajv-formats`; `src/schema/form-document.json` is the JSON
  Schema, `src/validate.ts` the validator, `src/convert/` the v1→v2
  converter. A party can validate and transform form documents with this
  and nothing else from the tree.
- **Renderer — example.** `packages/form-renderer/` (46 files, 3 307
  lines) is a React 19 component tree, with `docs/HOST-CONTRACT.md` listing
  obligations "the renderer cannot enforce". `packages/form-tokens/`
  (6 files, 185 lines) is styling; `apps/form-shell/` (30 files, 1 756
  lines) is a host prototype. Screens.

### `MissionAutopilotTester` — Example only; superseded for conformance by `contracts/runner`

- **Role.** From its `README.md`: "standalone single-file HTML React app for
  exercising any action server's REST API". Root README: "Browser harness
  for exercising any action server's REST API directly".
- **Paths.** `src/` 96 files, 9 006 lines; `src/features/` holds
  `connection-bar`, `invoke-panel`, `instance-panel`, `sidebar`, `upload`,
  `welcome-splash`, `branding`; `src/api/` (9 files, 907 lines) is the
  fetch layer; `HELP.md` 33 lines.
- **Evidence it is a manual tool with no pass/fail.** A search of
  `src/features/` and `src/store/` for `expect`, `assert`, `pass` or `fail`
  outside test files finds only prose comments and a `type="password"`
  attribute; there is no assertion, expected-response or verdict code. The
  user types the key into `ConnectionModal.tsx:112` and reads responses on
  screen.
- **Finding 3.** `src/api/capabilities.ts:23-24`, `commands.ts:30-31`,
  `instances.ts:23-24`, `invoke.ts:30-31` send the key as `Authorization`,
  which the reference container does not accept — recorded in
  `HARDENING.md` as finding 3.
- **Superseded.** `contracts/runner` is the conformance tool: it carries
  the numbered probes, produces a pass/fail verdict per target and is what
  this folder's contracts are checked with. The Tester stays useful as a
  debugging aid — poking one endpoint by hand and looking at the raw
  response — which the runner does not try to be.

### Samples, test data, seeds, Kitchen/Warehouse libraries — Example only (demo data)

- `MissionAutopilotTester/samples/` — 4 binary bundles: `Industrial
  Kitchen Action Library.WFactionLibX`, `Industrial Kitchen.WFenvirLibX`,
  `Warehouse Action Library.WFactionLibX`, `Automated Warehouse.WFenvirLibX`.
  These are the Kitchen and Warehouse libraries in packaged form.
- `MissionAutopilot/scripts/scenarios/` — 73 files, 2 923 lines: the same
  two scenarios as source, `kitchen/code/*` (PlateOrder, SearProtein,
  SimmerSauce, …) and `warehouse/code/*` (PickItem, ShipOrder, CycleCount,
  …), each a Python handler plus manifest, with a small `lib/` to load them.
- `MissionDesigner/test-data/` — 37 files, 30 521 lines of editor
  fixtures.
- `mission-control-db/src/seed/` — `demo.ts`, `sample-bundle.ts` and a test
  (3 files, 200 lines): demo seed for a fresh database.
- `MissionBroker/designer-library/` — the Distributed Workflow action
  library bundle (3 binary files) that the guide refers to.
- `MissionFormKit/packages/form-schema/src/fixtures/kitchen-sink.ts` — a
  one-file form-document fixture.
- **Evidence.** All are inputs to demonstrations or tests; none is imported
  by the server, engine or DAO code paths above. Useful for trying the
  system; not something to depend on.

## Things this report could not verify by reading

- Whether the Broker's `Authorization: Bearer`-only auth is intentional
  design for a second origin (the engine's client suggests it is) or an
  oversight to be folded into finding 3. That is a decision for the
  hardening list, not a code fact.
- The 79/0/3 baseline is quoted from `PROVENANCE.md`; it was not re-run
  (this folder's rule is never to run or touch
  `MissionEngine/src/conformance/`).
- `JSON_SCHEMA.md`'s own banner says its tool attributions are stale; this
  report did not audit which of its §18 paths still resolve.
