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

# Permission contract (`permission`)

Conformance clauses for the **permission decision** a Trajectory runtime
makes before it lets a subject act on a work center's resources: who may
start and control runs, what an agent may invoke, and when a change counts
as approved. The model is stack-neutral; §5 says plainly which parts of it
Dennis's Mission Commander implements today and which it does not.

Levels follow `contracts/README.md`: **MUST** fixtures gate the exit code.
Every fixture in this directory is MUST and cites its clause in `source` as
`C-PRM-<n>`.

Fixtures live in [`fixtures/`](fixtures/), one per file,
`prm-<nnn>-<slug>.json`.

## 1. Model

### 1.1 The decide request

Every fixture is one call to the conformance probe (§4):

```json
POST {probe_url}/permission/decide
{
  "subject":  { "kind": "user" | "agent", "id": "u1", "roles": ["operator"],
                "work_center": "wc-a", "mode": "observe" | "test" | "configure" },
  "verb":     "start" | "control:abort" | "control:stop" | "control:suspend"
            | "view" | "invoke_action" | "approve_change",
  "resource": { "work_center": "wc-a", "workflow_instance": "wi-1", "owner": "u2",
                "action_mode": "observe" | "test" | "configure",
                "change": { "author": "u3",
                            "approvals": [ { "by": "u4", "role": "process_engineer" } ] } },
  "grants":   [ { "from_work_center": "wc-b", "to_work_center": "wc-a", "scope": "own" | "any" } ],
  "policy":   { "quorum": [ { "role": "process_engineer" }, { "role": "operations_lead" } ],
                "separation_of_duties": "strict" }
}
-> 200 { "data": { "allowed": true | false, "reason": "<CODE>" }, "meta": {} }
```

- `subject.mode` is required when `kind` is `agent` and is the highest action
  mode the agent's policy lets it operate at. Ignored for users.
- `resource.owner` is the subject id that created the workflow instance. It
  is consulted by the `control:*` verbs only; `start` creates a new instance
  and has no owner yet.
- `resource.action_mode` is required for `invoke_action`: the mode the
  invoked action runs at.
- `resource.change` and `policy` are required for `approve_change` and
  ignored otherwise. `policy.separation_of_duties` has one defined value,
  `strict`.
- For `approve_change` the subject is the person applying the change on the
  strength of the signatures already collected in `resource.change.approvals`.
  The subject's own identity is never counted as a signature: a subject who
  holds a quorum role does not fill that role by asking (prm-013). The
  author may neither sign nor be the subject applying the change (§2.2).
- `grants` are **control grants**: they apply to `start` and `control:*`
  only. `invoke_action` and `approve_change` are in-work-center. `view` is
  in-work-center in the toy, but no fixture tests cross-work-center `view`
  and this contract does not rule on it (open question, §5.1).

A request that does not match this shape is answered `400 VALIDATION_ERROR`
in the REST error envelope (`docs/REST_Protocol.md` §1.5, §1.6), never with
a decision. A decision is only ever given for a well-formed request.

### 1.2 Roles and verbs

The role vocabulary is closed for the purpose of this contract so fixtures
are unambiguous. Fixtures send these names literally (`operator`,
`commander`, …) and the target profile has no slot for a mapping: how a
target relates its own role names to these is its internal concern, and its
probe does the translation (open question, §5.1).

| role | authorises |
|---|---|
| `viewer` | `view` |
| `operator` | `view`, `start`, `control:*`, `invoke_action` — `control:*` only on instances it owns (§2, NOT_OWNER) |
| `commander` | as `operator`, and `control:*` on any instance in its work center |
| `agent` | `view`, `invoke_action` (subject to C-PRM-3) |
| any role named in `policy.quorum` | `approve_change` |

Roles are held **per work center**: `subject.roles` are the roles the subject
holds in `subject.work_center`, nowhere else.

**Roles authorise verbs; subject kind does not.** `subject.kind` decides only
whether C-PRM-3 applies. An agent subject normally holds just `agent`; an
agent given `operator` may `start` and `control:*` exactly as a user with
that role would, and C-PRM-3 still binds its `invoke_action`. The toy
behaves this way and `permission-suite.test.mjs` pins it.

### 1.3 Mapping onto REST-05

`control:abort` → `ABORT`, `control:stop` → `STOP`, `control:suspend` →
`PAUSE`/`HOLD` (and the matching `RESUME`/`UNHOLD`), per
`docs/REST_Protocol.md` REST-05 and §3.2. `start` is the runtime creating an
instance; `invoke_action` is REST-03.

## 2. Reason codes

### 2.1 The closed set

A decision carries exactly one reason from this set; a target MUST NOT
answer with any other string.

| reason | allowed | meaning |
|---|---|---|
| `OK` | true | every applicable check passed |
| `NO_ROLE` | false | no held role authorises the verb (includes holding no role at all) |
| `WRONG_WORK_CENTER` | false | resource is in another work center and no grant from the subject's work center reaches it (or the verb is not grantable) |
| `GRANT_SCOPE_OWN` | false | a grant reaches the resource's work center but its scope is `own` and the subject does not own the instance |
| `NOT_OWNER` | false | in the subject's own work center, a `control:*` verb on an instance the subject does not own, without `commander` |
| `AGENT_MODE_EXCEEDED` | false | an agent's `invoke_action` where `resource.action_mode` ranks above `subject.mode` (`observe` < `test` < `configure`) |
| `SELF_APPROVAL` | false | the change author appears in `approvals`, or the author is the subject applying the change |
| `SAME_PERSON_TWICE` | false | one person appears in two or more approvals (strict separation of duties) |
| `QUORUM_NOT_MET` | false | the approvals are from distinct non-authors, yet some role in `policy.quorum` has no approval |

### 2.2 Distinguishing the three approval reasons

They are defined so that at most one applies, in this order:

1. **SELF_APPROVAL** — `change.author` is among `approvals[].by`, or equals
   `subject.id` (the author applying their own change). The author's
   signature *never counts* (C-PRM-4), and a request that relies on it is
   refused with this reason even when every quorum role is otherwise signed
   (prm-014). Only `approvals` are signatures; the subject's identity is
   not one (§1.1).
2. **SAME_PERSON_TWICE** — the same `by` appears twice. Signing two roles with
   one identity is a separation-of-duties breach, not merely a short quorum
   (prm-015).
3. **QUORUM_NOT_MET** — the approvals are from distinct non-authors, yet some
   role in `policy.quorum` has no signature (prm-013).

### 2.3 Precedence

When several reasons could apply the first in this order is returned, so each
fixture has exactly one correct answer:

```
400 VALIDATION_ERROR
  > NO_ROLE
  > WRONG_WORK_CENTER > GRANT_SCOPE_OWN > NOT_OWNER
  > AGENT_MODE_EXCEEDED
  > SELF_APPROVAL > SAME_PERSON_TWICE > QUORUM_NOT_MET
  > OK
```

Who you are is checked before where you are; where you are before what you
may do there; approvals last. prm-008 pins the first step (no role, wrong
work center → `NO_ROLE`).

## 3. Clauses

**C-PRM-1 — Deny by default.** A request is allowed only when a held role
authorises the verb and every check in §2.3 passes. Holding no role, or no
role that authorises the verb, is `NO_ROLE`.

**C-PRM-2 — Work centers and control grants.** A subject acts in its own
work center. To `start` or `control:*` in another work center it needs a
grant `{from_work_center: <its own>, to_work_center: <the resource's>}`. A
grant with scope `own` lets the grantee control only instances it owns
(`resource.owner == subject.id`); `any` lets it control all. Inside its own
work center an `operator` controls only instances it owns; `commander`
controls all.

**C-PRM-3 — Agent mode.** An agent subject may never exceed the action's
mode: with `observe` < `test` < `configure`, `invoke_action` is denied when
`resource.action_mode` ranks above `subject.mode`. An observe agent cannot
invoke a configure action.

**C-PRM-4 — Quorum.** `approve_change` is allowed only when every role in
`policy.quorum` is signed by a distinct person and none of them is the
change author. The author's signature never counts.

**C-PRM-5 — Pure function; probe is test-only.** The decision is a pure
function of the request body: same request, same answer, no state read or
written. A malformed request is `400 VALIDATION_ERROR`, not a decision. The
`/permission/decide` probe exists for conformance testing only and **MUST
NOT be exposed in production**; a production deployment that mounts it fails
this contract regardless of what it answers.

## 4. Conformance probe

The permission fixtures do not exercise the production surface at
`/trajectory/v1`; they exercise a **conformance probe** the target mounts
separately, under test only. A target declares it with the capability
`permission_probe` and a `probe_url` (the base of the probe, e.g.
`…/conformance/v1`). No role is needed: every request is self-contained.
Fixtures carry `requires: ["permission_probe"]` and their single request
step is marked `probe: true`, so it is sent to `probe_url` instead of
`base_url`. A target without `permission_probe` skips all sixteen. Probe
endpoints use the same `X-API-Key` header and the REST envelope
(`docs/REST_Protocol.md` §1.3, §1.5).

**`POST {probe_url}/permission/decide`** — body as §1.1. Answers
`200 { "data": { "allowed", "reason" }, "meta": {} }` or
`400 VALIDATION_ERROR`.

### 4.1 Fixtures

| fixture | source | case | expects |
|---|---|---|---|
| prm-001 | C-PRM-1 | operator, `start`, own work center | `OK` |
| prm-002 | C-PRM-1 | no roles at all | `NO_ROLE` |
| prm-003 | C-PRM-1 | viewer asks to `start` | `NO_ROLE` |
| prm-004 | C-PRM-2 | other work center, grant reaches a third centre only | `WRONG_WORK_CENTER` |
| prm-005 | C-PRM-2 | grant matrix: `own`, subject owns | `OK` |
| prm-006 | C-PRM-2 | grant matrix: `own`, subject does not own | `GRANT_SCOPE_OWN` |
| prm-007 | C-PRM-2 | grant matrix: `any`, subject does not own | `OK` |
| prm-008 | C-PRM-1 | precedence: no role **and** wrong work center | `NO_ROLE` |
| prm-009 | C-PRM-2 | operator, own work center, `control:abort` on another's instance | `NOT_OWNER` |
| prm-010 | C-PRM-2 | commander, same request as prm-009 | `OK` |
| prm-011 | C-PRM-3 | observe agent invokes configure action | `AGENT_MODE_EXCEEDED` |
| prm-012 | C-PRM-3 | test agent invokes observe action | `OK` |
| prm-013 | C-PRM-4 | one of two quorum roles unsigned | `QUORUM_NOT_MET` |
| prm-014 | C-PRM-4 | author signs one quorum role, another person the other | `SELF_APPROVAL` |
| prm-015 | C-PRM-4 | one person signs both quorum roles | `SAME_PERSON_TWICE` |
| prm-016 | C-PRM-5 | unknown verb | `400 VALIDATION_ERROR`, no `data` |

## 5. What Dennis's Mission Commander covers today

Stated so nobody mistakes the probe for a description of the shipped
product. Sources: `MissionCommander/HELP.md` and
`docs/DISTRIBUTED_WORKFLOW_LIBRARY.md`; `docs/REST_Protocol.md` has no
permission model of its own.

**Covered today — `start` and `control:*` by role and grant.**

- Starting, pausing, resuming, stopping and aborting runtime workflows is
  the per-work-center **Mission System Commander** flag (HELP §3, "Mission
  System Commander"). That is this contract's `commander` role: control of
  any instance in the work center where the flag is held.
- Roles are held **per work center** (HELP §8): a role in one work center
  "holds nothing in another". C-PRM-1's `NO_ROLE` and C-PRM-2's
  `WRONG_WORK_CENTER` follow that rule.
- Cross-work-center control is by **control grant** on the work center's
  Control tab (HELP §4 "Control grants";
  `DISTRIBUTED_WORKFLOW_LIBRARY.md` §2.1 step 4): "Only runtimes it created"
  is this contract's scope `own`, "Any runtime" is `any`. The verbs the
  grant covers are create/start, stop, abort, suspend and unsuspend; a
  refusal surfaces as Completion.Code 3 "Not permitted (no control grant, or
  the runtime was not created by the caller's lineage)"
  (`DISTRIBUTED_WORKFLOW_LIBRARY.md` §3). That is `WRONG_WORK_CENTER` and
  `GRANT_SCOPE_OWN` respectively. Note the shipped grant is held by a
  *workflow's runtime* reaching across work centers, whereas the probe's
  `subject` is a user or agent; the scope semantics are the same.
- Reading a runtime's state (`view`) across work centers "needs either kind
  of grant" (HELP §4). The toy keeps `view` in-work-center only, which is
  stricter, but this contract does not rule on it: no fixture asks for
  cross-centre `view`, so a target that grants it conforms. Open question
  (§5.1).

**Not covered today.**

- **Agent subjects and action modes (C-PRM-3).** The REST protocol
  authenticates a server-wide `X-API-Key` (`docs/REST_Protocol.md` §1.3);
  there is no per-agent identity or mode on the wire, and the Commander has
  no notion of `observe`/`test`/`configure`. This part of the model is
  Athion's agent policy and is new.
- **Change-approval quorum with separation of duties (C-PRM-4).** The
  Commander has single-signer e-signatures on a step (HELP §15): the signer
  must hold the role in that work center, and an element can demand "a
  different user than the operator" (`SIGNATURE_SAME_USER`). That is the
  seed of `SELF_APPROVAL`, but there is no multi-role quorum over a *change*
  and no `SAME_PERSON_TWICE` check across several signatures. New.
- `NOT_OWNER` inside a work center: the shipped Commander flag is all-or-
  nothing per work center; it does not distinguish an operator's own runs
  from others'. The `operator`/`commander` split here is a refinement.

### 5.1 Open questions for Dennis

These are proposals in this contract, not settled facts. Task 15/17 carry
them into HARDENING and HANDOFF.

1. **`subject.mode`** — the agent's highest action mode travels on the
   subject (§1.1) because nothing on the wire carries a per-agent identity
   today. Is that the right place, and is `observe < test < configure` the
   right ladder?
2. **The `commander` role name** — this contract calls the per-work-center
   "Mission System Commander" flag a role named `commander`. Keep that name,
   or use the product's own?
3. **`view` scope** — the shipped Commander lets a control grant also grant
   cross-centre reads (HELP §4); the toy keeps `view` in-work-center. Which
   should the contract pin, if either? Until answered, no fixture tests it.
4. **Role-name mapping** — fixtures send `viewer`/`operator`/`commander`/
   `agent` literally and the target profile has no mapping slot (§1.2).
   Should the profile gain one, or does each target's probe translate?

## 6. Expected results against the toy

The in-process toy (`contracts/runner/test/toy-container.mjs`) mounts the
probe at `/conformance/v1` and decides with the exported pure function
`decidePermission`. With no defects every fixture passes: **16 pass, 0
fail, 0 note, 0 skip**, exit `0`. The `permit-self-approval` defect lets
the author's signature count and fails exactly **prm-014**; prm-013 and
prm-015 contain no author signature and are unaffected. A copy of the toy
target without `permission_probe` gives **0 pass, 0 fail, 0 note, 16
skip**, exit `0`.
