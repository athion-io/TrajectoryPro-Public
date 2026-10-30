// Copyright 2026 Athion, Inc.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Reference toy Action Container, in process. `makeToy()` returns a fake
// `fetch(url, init) -> Response` that speaks docs/REST_Protocol.md
// (REST-01..06, 08, 09) and the wire shapes the contract fixtures expect.
// No sockets and no real timers: state only advances through `tick(ms)`.
//
// Defects are opt-in switches so broken-toy fixtures can prove the runner
// catches each one. Each defect breaks exactly the behaviour its name says:
//   bad-envelope           responses are not wrapped in {data,meta}/{error}
//   accept-any-command     any `command` string is accepted with 200: unknown
//                          names are not 422 and the §3 state table is skipped
//                          (context.md: "accepts bad command")
//   no-auth                X-API-Key is not checked
//   non-idempotent-invoke  re-invoking the same step creates a new instance
//   no-ring-replay         Last-Event-ID is ignored; no buffered replay
//   break-chain            audit trail exported by /conformance/v1/audit/export has a
//                          broken prev_hash link at index 2 (audit-trail aud-010)
//   lying-readback         permission read-back differs from what was granted (later task)
//   permit-self-approval   the change author's own signature counts towards the
//                          quorum (permission prm-014, C-PRM-4)
// The /conformance/v1/* probe surface (PROBE_ROUTES) carries the audit and
// permission probes; a later task adds the connector probe there. Add routes
// to ROUTES or PROBE_ROUTES and consult `defects.has(...)` at the point of
// failure.

import { canonicalize, sha256Digest } from '../src/jcs.mjs';
import { eventHash, verifyChain } from '../src/audit.mjs';

const ROOT = '/trajectory/v1';
const PROBE_ROOT = '/conformance/v1';
const RING_SIZE = 256;

export const DEFECTS = Object.freeze([
  'bad-envelope', 'accept-any-command', 'no-auth', 'non-idempotent-invoke', 'no-ring-replay',
  'break-chain', 'lying-readback', 'permit-self-approval',
]);

/**
 * Extensions the toy can be built with (`makeToy({extensions: [...]})`).
 * A toy built without one behaves exactly as if the extension did not exist.
 *   forwarded-identity  X-Trajectory-User: Bearer <user token> is checked on
 *                       every authenticated route (agent-action CONTRACT §12)
 */
export const EXTENSIONS = Object.freeze(['forwarded-identity']);

/**
 * User tokens the forwarded-identity toy recognises. Clearly fake fixture
 * values, never real credentials: tests hand them to the runner as
 * `userTokens` the way CONTRACTS_USER_TOKEN / CONTRACTS_UNGRANTED_USER_TOKEN
 * would. The toy keeps the token -> user map only to answer the check; no
 * token is ever written to an instance or an event.
 */
export const TOY_USER_TOKENS = Object.freeze({
  granted: 'toy-user-token-granted-fixture',
  ungranted: 'toy-user-token-ungranted-fixture',
});

const TOY_USERS = Object.freeze({
  [TOY_USER_TOKENS.granted]: { subject: 'user-granted', granted: true },
  [TOY_USER_TOKENS.ungranted]: { subject: 'user-ungranted', granted: false },
});

/** Toy roles that the target file refers to. */
export const TOY_ROLES = Object.freeze({
  environment_oid: 'env-c1',
  observable_action: 'act-hold',
  opaque_action: 'act-opaque',
  fast_action: 'act-fast',
  offline_action: 'act-offline',
  unknown_action: 'act-nope',
  guarded_action: 'act-guarded',
  audit_scope: 'wf-toy-1',
});

const ACTIONS = {
  'act-hold': { visibility: 'observable', description: 'Holds in EXECUTING until commanded' },
  'act-opaque': { visibility: 'opaque', description: 'Completes on its own after a few ticks' },
  'act-fast': { visibility: 'observable', description: 'Enters COMPLETING one tick after invoke and completes 300 ticks later' },
  'act-offline': { visibility: 'observable', description: 'Agent is unavailable', offline: true },
  'act-guarded': { visibility: 'observable', description: 'Guarded by a permission (later task)' },
};

export const COMMANDS = ['PAUSE', 'RESUME', 'HOLD', 'UNHOLD', 'ABORT', 'STOP', 'CLEAR'];

// ---------- permission decision (permission CONTRACT, C-PRM-1..5) ----------

/** The closed reason-code set of permission/CONTRACT.md §2. */
export const PERMISSION_REASONS = Object.freeze([
  'OK', 'NO_ROLE', 'WRONG_WORK_CENTER', 'GRANT_SCOPE_OWN', 'NOT_OWNER',
  'AGENT_MODE_EXCEEDED', 'QUORUM_NOT_MET', 'SELF_APPROVAL', 'SAME_PERSON_TWICE',
]);

const PRM_VERBS = ['start', 'control:abort', 'control:stop', 'control:suspend', 'view', 'invoke_action', 'approve_change'];
const PRM_MODES = ['observe', 'test', 'configure'];
const PRM_SCOPES = ['own', 'any'];

/** permission/CONTRACT.md §1.2: which held role authorises which verb. */
const PRM_ROLE_VERBS = {
  viewer: ['view'],
  operator: ['view', 'start', 'control:abort', 'control:stop', 'control:suspend', 'invoke_action'],
  commander: ['view', 'start', 'control:abort', 'control:stop', 'control:suspend', 'invoke_action'],
  agent: ['view', 'invoke_action'],
};

class PermissionRequestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PermissionRequestError';
  }
}

/** Validates the decide request shape (CONTRACT §1.1). Throws PermissionRequestError. */
function checkPermissionRequest(req) {
  const bad = (m) => { throw new PermissionRequestError(m); };
  const isStr = (v) => typeof v === 'string' && v.length > 0;
  if (!req || typeof req !== 'object' || Array.isArray(req)) bad('request must be a JSON object');
  const { subject, verb, resource, grants, policy } = req;
  if (!subject || typeof subject !== 'object') bad('subject must be an object');
  if (!['user', 'agent'].includes(subject.kind)) bad('subject.kind must be user or agent');
  if (!isStr(subject.id)) bad('subject.id must be a non-empty string');
  if (!Array.isArray(subject.roles) || !subject.roles.every(isStr)) bad('subject.roles must be an array of strings');
  if (!isStr(subject.work_center)) bad('subject.work_center must be a non-empty string');
  if (subject.kind === 'agent' && !PRM_MODES.includes(subject.mode)) bad('subject.mode must be observe, test or configure for an agent');
  if (!PRM_VERBS.includes(verb)) bad(`verb must be one of ${PRM_VERBS.join(', ')}`);
  if (!resource || typeof resource !== 'object') bad('resource must be an object');
  if (!isStr(resource.work_center)) bad('resource.work_center must be a non-empty string');
  if ('owner' in resource && !isStr(resource.owner)) bad('resource.owner must be a non-empty string');
  if ('action_mode' in resource && !PRM_MODES.includes(resource.action_mode)) bad('resource.action_mode must be observe, test or configure');
  if (verb === 'invoke_action' && !('action_mode' in resource)) bad('resource.action_mode is required for invoke_action');
  if (grants !== undefined) {
    if (!Array.isArray(grants)) bad('grants must be an array');
    for (const g of grants) {
      if (!g || typeof g !== 'object' || !isStr(g.from_work_center) || !isStr(g.to_work_center) || !PRM_SCOPES.includes(g.scope)) {
        bad('each grant must be {from_work_center, to_work_center, scope: own|any}');
      }
    }
  }
  if (verb === 'approve_change') {
    const change = resource.change;
    if (!change || typeof change !== 'object') bad('resource.change is required for approve_change');
    if (!isStr(change.author)) bad('resource.change.author must be a non-empty string');
    if (!Array.isArray(change.approvals) || !change.approvals.every((a) => a && typeof a === 'object' && isStr(a.by) && isStr(a.role))) {
      bad('resource.change.approvals must be an array of {by, role}');
    }
    if (!policy || typeof policy !== 'object') bad('policy is required for approve_change');
    if (!Array.isArray(policy.quorum) || policy.quorum.length === 0 || !policy.quorum.every((q) => q && typeof q === 'object' && isStr(q.role))) {
      bad('policy.quorum must be a non-empty array of {role}');
    }
    if (policy.separation_of_duties !== 'strict') bad('policy.separation_of_duties must be "strict"');
  }
}

/**
 * The permission decision: a pure function of the request (C-PRM-5). Reads
 * nothing but `req`, writes nothing, and returns {allowed, reason} with
 * `reason` from PERMISSION_REASONS, in the precedence order of CONTRACT §2.3.
 * `options.permitSelfApproval` is the permit-self-approval defect switch.
 * Throws PermissionRequestError on a malformed request.
 */
export function decidePermission(req, { permitSelfApproval = false } = {}) {
  checkPermissionRequest(req);
  const { subject, verb, resource, grants = [], policy } = req;
  const deny = (reason) => ({ allowed: false, reason });
  const isControl = verb.startsWith('control:');

  // C-PRM-1: a held role must authorise the verb; for approve_change the
  // role must be one the quorum names.
  const verbRoles = verb === 'approve_change'
    ? policy.quorum.map((q) => q.role)
    : Object.keys(PRM_ROLE_VERBS).filter((r) => PRM_ROLE_VERBS[r].includes(verb));
  if (!subject.roles.some((r) => verbRoles.includes(r))) return deny('NO_ROLE');

  // C-PRM-2: work center, then grant scope, then ownership.
  if (subject.work_center !== resource.work_center) {
    const grantable = verb === 'start' || isControl;
    const grant = grantable
      ? grants.find((g) => g.from_work_center === subject.work_center && g.to_work_center === resource.work_center)
      : undefined;
    if (!grant) return deny('WRONG_WORK_CENTER');
    if (grant.scope === 'own' && isControl && resource.owner !== subject.id) return deny('GRANT_SCOPE_OWN');
  } else if (isControl && resource.owner !== subject.id && !subject.roles.includes('commander')) {
    return deny('NOT_OWNER');
  }

  // C-PRM-3: an agent never exceeds the action's mode.
  if (subject.kind === 'agent' && verb === 'invoke_action'
    && PRM_MODES.indexOf(resource.action_mode) > PRM_MODES.indexOf(subject.mode)) {
    return deny('AGENT_MODE_EXCEEDED');
  }

  // C-PRM-4: self-approval, then the same person twice, then the quorum.
  if (verb === 'approve_change') {
    const { author, approvals } = resource.change;
    if (!permitSelfApproval && (subject.id === author || approvals.some((a) => a.by === author))) return deny('SELF_APPROVAL');
    const people = approvals.map((a) => a.by);
    if (new Set(people).size !== people.length) return deny('SAME_PERSON_TWICE');
    const counted = permitSelfApproval ? approvals : approvals.filter((a) => a.by !== author);
    for (const { role } of policy.quorum) {
      if (!counted.some((a) => a.role === role)) return deny('QUORUM_NOT_MET');
    }
  }

  return { allowed: true, reason: 'OK' };
}

/** Ticks act-fast spends in COMPLETING before COMPLETED. */
export const FAST_COMPLETING_TICKS = 300;

/** REST_Protocol §3: which commands are valid in which state. */
const VALID_COMMANDS = {
  POSTED: ['ABORT'],
  RECEIVED: ['ABORT'],
  IN_PROGRESS: ['ABORT'],
  STARTING: ['ABORT', 'STOP'],
  EXECUTING: ['PAUSE', 'HOLD', 'ABORT', 'STOP'],
  PAUSED: ['RESUME', 'ABORT', 'STOP'],
  HELD: ['UNHOLD', 'ABORT', 'STOP'],
  COMPLETING: ['ABORT', 'STOP'],
  ABORTED: ['CLEAR'],
};

/** command -> [transient state, settled state]. CLEAR is handled apart (§3.2: engine-defined, no state). */
const COMMAND_PATH = {
  PAUSE: ['PAUSING', 'PAUSED'],
  RESUME: ['RESUMING', 'EXECUTING'],
  HOLD: ['HOLDING', 'HELD'],
  UNHOLD: ['UNHOLDING', 'EXECUTING'],
  STOP: ['STOPPING', 'STOPPED'],
  ABORT: ['ABORTING', 'ABORTED'],
};

/** §3.1: the only terminal states; nothing is emitted after the terminal state_change. */
const TERMINAL = new Set(['COMPLETED', 'STOPPED', 'ABORTED']);

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, X-API-Key, Last-Event-ID',
  'access-control-expose-headers': 'Content-Type',
};

/**
 * @param {{apiKey?: string, defects?: Set<string>|string[], clock?: {now(): number}, eventIdBase?: number, extensions?: string[]}} [opts]
 *   eventIdBase: id of the first SSE frame (default 0); tests use 1 to prove fixtures do not depend on it.
 *   extensions: names from EXTENSIONS the toy implements (default none).
 * @returns {{fetch(url: string|URL, init?: RequestInit): Promise<Response>, tick(ms: number): Promise<void>, defects: Set<string>, extensions: Set<string>, userTokens: typeof TOY_USER_TOKENS, state: object}}
 */
export function makeToy({ apiKey = 'k', defects = new Set(), clock, eventIdBase = 0, extensions = [] } = {}) {
  defects = defects instanceof Set ? defects : new Set(defects);
  for (const d of defects) {
    if (!DEFECTS.includes(d)) throw new Error(`makeToy: unknown defect '${d}' (known: ${DEFECTS.join(', ')})`);
  }
  extensions = new Set(extensions);
  for (const e of extensions) {
    if (!EXTENSIONS.includes(e)) throw new Error(`makeToy: unknown extension '${e}' (known: ${EXTENSIONS.join(', ')})`);
  }
  let virtualNow = clock ? clock.now() : 0;
  const now = () => (clock ? clock.now() : virtualNow);
  const iso = () => new Date(now()).toISOString();

  /** @type {Map<string, object>} instance_id -> instance record */
  const instances = new Map();
  /** @type {Map<string, string>} idempotency tuple -> instance_id */
  const invokeIndex = new Map();
  /** @type {Map<string, {events: object[], nextId: number, subscribers: Set<Function>}>} */
  const buses = new Map();
  /** Transitions due at a virtual time; drained by tick(). */
  let pending = [];
  let seq = 0;
  let elapsed = 0;

  // ---------- envelopes ----------

  function json(status, body, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json', ...CORS_HEADERS, ...extraHeaders },
    });
  }

  function ok(status, data, meta = {}, headers) {
    // bad-envelope: return the bare payload with no {data, meta} wrapper.
    if (defects.has('bad-envelope')) return json(status, data, headers);
    return json(status, { data, meta }, headers);
  }

  function fail(status, code, message, details = {}) {
    // bad-envelope: errors lose the {error:{...}} wrapper too.
    if (defects.has('bad-envelope')) return json(status, { code, message });
    return json(status, { error: { code, message, details } });
  }

  // ---------- instances and the state machine ----------

  function bus(id) {
    let b = buses.get(id);
    if (!b) {
      b = { events: [], nextId: eventIdBase, subscribers: new Set() };
      buses.set(id, b);
    }
    return b;
  }

  function emit(id, event, data) {
    const b = bus(id);
    const frame = { id: b.nextId++, event, data };
    b.events.push(frame);
    if (b.events.length > RING_SIZE) b.events.splice(0, b.events.length - RING_SIZE);
    for (const sub of b.subscribers) sub(frame);
  }

  function setState(inst, next) {
    const previous = inst.state.current;
    inst.state = { current: next, previous, entered_at: iso() };
    if (next === 'EXECUTING' && !inst.started_at) inst.started_at = iso();
    if (TERMINAL.has(next)) {
      inst.completed_at = iso();
      if (next === 'COMPLETED') emit(inst.instance_id, 'output', { instance_id: inst.instance_id, outputs: inst.outputs, timestamp: iso() });
    }
    emit(inst.instance_id, 'state_change', { instance_id: inst.instance_id, state: next, previous_state: previous, timestamp: iso() });
  }

  function schedule(delayMs, fn) {
    pending.push({ at: elapsed + delayMs, fn });
  }

  /** Advance virtual time; run every transition due by then, in order. */
  async function tick(ms) {
    elapsed += ms;
    if (!clock) virtualNow += ms;
    let due;
    while ((due = pending.filter((p) => p.at <= elapsed)).length) {
      pending = pending.filter((p) => p.at > elapsed);
      due.sort((a, b) => a.at - b.at);
      for (const p of due) p.fn();
    }
    await new Promise((resolve) => setImmediate(resolve));
  }

  function startInstance(inst) {
    const action = ACTIONS[inst.action_oid];
    if (action.visibility === 'opaque') {
      // POSTED -> RECEIVED -> IN_PROGRESS -> COMPLETED, one tick apart.
      schedule(1, () => inst.state.current === 'POSTED' && setState(inst, 'RECEIVED'));
      schedule(2, () => inst.state.current === 'RECEIVED' && setState(inst, 'IN_PROGRESS'));
      schedule(3, () => inst.state.current === 'IN_PROGRESS' && complete(inst));
      return;
    }
    schedule(1, () => inst.state.current === 'STARTING' && setState(inst, 'EXECUTING'));
    if (inst.action_oid === 'act-fast') {
      // Same tick as EXECUTING, so one tick() sees STARTING -> EXECUTING -> COMPLETING; the
      // COMPLETING window is long enough for a wait_state poll (250 ms) to observe it.
      schedule(1, () => inst.state.current === 'EXECUTING' && setState(inst, 'COMPLETING'));
      schedule(FAST_COMPLETING_TICKS + 1, () => inst.state.current === 'COMPLETING' && complete(inst));
    }
  }

  function complete(inst) {
    // REST-04: outputs is [{name, value}] with stringified values.
    inst.outputs = [
      { name: 'result', value: 'ok' },
      { name: 'input_count', value: String(inst.inputs.length) },
    ];
    setState(inst, 'COMPLETED');
  }

  function publicInstance(inst) {
    return { ...inst, state: { ...inst.state } };
  }

  // ---------- handlers ----------

  function handleHealth() {
    return ok(200, { status: 'ok', timestamp: iso(), pool: { active: [...instances.values()].filter((i) => !TERMINAL.has(i.state.current)).length } });
  }

  function handleCapabilities() {
    // REST-02 shape (REST_Protocol.md:177-218).
    const actions = Object.entries(ACTIONS).map(([action_oid, a]) => ({
      action_oid,
      action_name: action_oid,
      action_state: 'Effective',
      local_id: action_oid,
      version: '1.0.0',
      description: a.description,
      visibility: a.visibility,
      input_parameters: [],
      output_parameters: [
        { name: 'result', description: 'ok on completion' },
        { name: 'input_count', description: 'number of input parameters received' },
      ],
      supported_commands: a.visibility === 'opaque' ? ['ABORT'] : COMMANDS,
    }));
    return ok(200, {
      environments: [{
        environment_oid: TOY_ROLES.environment_oid,
        environment_name: 'Toy environment',
        environment_state: 'Effective',
        action_properties: [],
        actions,
      }],
    }, { total_environments: 1, total_actions: actions.length });
  }

  function handleInvoke(req, [actionOid]) {
    // REST-03: action in the path, environment in the body.
    const action = ACTIONS[actionOid];
    if (!action) return fail(404, 'NOT_FOUND', 'unknown action', { action_oid: actionOid });
    const body = req.body;
    if (!body || typeof body !== 'object') return fail(400, 'VALIDATION_ERROR', 'body must be a JSON object');
    const missing = ['environment_oid', 'workflow_instance_id', 'step_instance_id', 'step_oid', 'input_parameters']
      .filter((k) => body[k] === undefined || body[k] === null);
    if (missing.length || !Array.isArray(body.input_parameters)) {
      return fail(400, 'VALIDATION_ERROR', 'missing or invalid fields', { missing, input_parameters: Array.isArray(body.input_parameters) ? 'ok' : 'must be an array' });
    }
    const envOid = body.environment_oid;
    if (envOid !== TOY_ROLES.environment_oid) {
      return fail(404, 'NOT_FOUND', 'unknown environment', { environment_oid: envOid });
    }
    if (action.offline) return fail(409, 'AGENT_UNAVAILABLE', 'the agent for this action is offline', { action_oid: actionOid });

    // D9 idempotency: same (environment, workflow instance, step instance, action) -> same instance.
    const key = [envOid, body.workflow_instance_id, body.step_instance_id, actionOid].join('\u0000');
    // non-idempotent-invoke: forget earlier invokes, so a retry creates a second instance.
    if (!defects.has('non-idempotent-invoke') && invokeIndex.has(key)) {
      return ok(201, { instance_id: invokeIndex.get(key) }, { idempotent: true });
    }
    const inst = {
      instance_id: `inst-${++seq}`,
      action_oid: actionOid,
      environment_oid: envOid,
      workflow_instance_id: body.workflow_instance_id,
      step_instance_id: body.step_instance_id,
      step_oid: body.step_oid,
      visibility: action.visibility,
      state: { current: action.visibility === 'opaque' ? 'POSTED' : 'STARTING', previous: null, entered_at: iso() },
      inputs: body.input_parameters,
      outputs: [],
      created_at: iso(),
      started_at: null,
      completed_at: null,
      error: null,
    };
    instances.set(inst.instance_id, inst);
    invokeIndex.set(key, inst.instance_id);
    emit(inst.instance_id, 'state_change', { instance_id: inst.instance_id, state: inst.state.current, previous_state: null, timestamp: iso() });
    startInstance(inst);
    return ok(201, { instance_id: inst.instance_id });
  }

  function handleGetInstance(req, [id]) {
    const inst = instances.get(id);
    if (!inst) return fail(404, 'INSTANCE_NOT_FOUND', 'no such instance', { instance_id: id });
    return ok(200, publicInstance(inst));
  }

  function handleListInstances(req) {
    const q = req.url.searchParams;
    let list = [...instances.values()];
    if (q.has('workflow_instance_id')) list = list.filter((i) => i.workflow_instance_id === q.get('workflow_instance_id'));
    if (q.has('action_oid')) list = list.filter((i) => i.action_oid === q.get('action_oid'));
    if (q.has('status')) {
      const s = q.get('status');
      list = s === 'active' ? list.filter((i) => !TERMINAL.has(i.state.current)) : list.filter((i) => i.state.current === s);
    }
    return ok(200, list.map(publicInstance), { total: list.length });
  }

  function handleCommand(req, [id]) {
    const inst = instances.get(id);
    if (!inst) return fail(404, 'INSTANCE_NOT_FOUND', 'no such instance', { instance_id: id });
    const command = req.body?.command;
    const anyCommand = defects.has('accept-any-command');
    // accept-any-command: any string is "accepted" (no 422 for unknown names, no §3 state table).
    // An unknown name then does nothing to the state; a known one transitions regardless of state.
    if (typeof command !== 'string' || (!anyCommand && !COMMANDS.includes(command))) {
      return fail(422, 'INVALID_COMMAND', 'unknown command', { command, supported: COMMANDS });
    }
    const current = inst.state.current;
    const valid = VALID_COMMANDS[current] ?? [];
    if (!anyCommand && !valid.includes(command)) {
      return fail(409, 'INVALID_STATE_TRANSITION', `${command} is not valid in state ${current}`, { state: current, valid_commands: valid });
    }
    if (command === 'CLEAR') {
      // §3.2: engine-defined; the toy removes the instance. §3.1: nothing is
      // emitted after the terminal state_change, so this is silent.
      clearInstance(inst);
    } else if (COMMAND_PATH[command]) {
      const [transient, settled] = COMMAND_PATH[command];
      setState(inst, transient);
      schedule(1, () => inst.state.current === transient && setState(inst, settled));
    }
    return ok(200, { instance_id: id, command, accepted: true });
  }

  function clearInstance(inst) {
    instances.delete(inst.instance_id);
    for (const [key, id] of invokeIndex) if (id === inst.instance_id) invokeIndex.delete(key);
  }

  function handleDelete(req, [id]) {
    const inst = instances.get(id);
    if (!inst) return fail(404, 'INSTANCE_NOT_FOUND', 'no such instance', { instance_id: id });
    if (!TERMINAL.has(inst.state.current)) {
      setState(inst, 'ABORTING');
      schedule(1, () => inst.state.current === 'ABORTING' && setState(inst, 'ABORTED'));
    }
    return ok(200, { instance_id: id, cancelled: true });
  }

  function handleEvents(req, [id]) {
    if (!instances.has(id)) return fail(404, 'INSTANCE_NOT_FOUND', 'no such instance', { instance_id: id });
    // §3.3: an opaque instance has no event stream. The exact 4xx is implementation-defined.
    if (instances.get(id).visibility === 'opaque') {
      return fail(404, 'NOT_FOUND', 'opaque instances have no event stream', { instance_id: id });
    }
    const b = bus(id);
    const encoder = new TextEncoder();
    const lastHeader = req.headers.get('last-event-id');
    const lastId = lastHeader !== null && /^\d+$/.test(lastHeader) ? Number(lastHeader) : null;
    const frame = (f) => encoder.encode(`id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);

    let subscriber;
    const body = new ReadableStream({
      start(controller) {
        // §4.2: replay id > Last-Event-ID; without the header start from the next live event.
        // no-ring-replay: ignore Last-Event-ID and send nothing from the buffer.
        if (lastId !== null && !defects.has('no-ring-replay')) {
          for (const f of b.events.filter((f) => f.id > lastId)) controller.enqueue(frame(f));
        }
        subscriber = (f) => {
          try { controller.enqueue(frame(f)); } catch { b.subscribers.delete(subscriber); }
        };
        b.subscribers.add(subscriber);
        const close = () => {
          b.subscribers.delete(subscriber);
          try { controller.close(); } catch { /* already closed */ }
        };
        if (req.signal) {
          if (req.signal.aborted) close();
          else req.signal.addEventListener('abort', close, { once: true });
        }
      },
      cancel() {
        b.subscribers.delete(subscriber);
      },
    });
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', ...CORS_HEADERS },
    });
  }

  function handleOptions() {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // ---------- routing ----------

  /** Route table: [method, path regex relative to ROOT, handler, {auth}] (REST_Protocol.md §2). */
  const ROUTES = [
    ['GET', /^\/health$/, handleHealth, { auth: false }],
    ['GET', /^\/capabilities$/, handleCapabilities],
    ['POST', /^\/actions\/([^/]+)\/invoke$/, handleInvoke],
    ['GET', /^\/instances$/, handleListInstances],
    ['GET', /^\/instances\/([^/]+)$/, handleGetInstance],
    ['POST', /^\/instances\/([^/]+)\/command$/, handleCommand],
    ['DELETE', /^\/instances\/([^/]+)$/, handleDelete],
    ['GET', /^\/instances\/([^/]+)\/events$/, handleEvents],
  ];

  // ---------- /conformance/v1 probe surface (audit-trail CONTRACT) ----------

  /**
   * The toy's audit trail for a scope: five chained events in C-AUD-1 shape,
   * hashed with the runner's own recipe (C-AUD-3/4). Deterministic per scope.
   * break-chain: the third event claims a wrong predecessor, so an offline
   * verifier reports broken_link at index 2.
   */
  function auditTrail(scopeId) {
    const t0 = Date.UTC(2026, 9, 29, 12, 0, 0, 0);
    const mk = (i, actor, action, resource_type, resource_id, rev, reason, payload) => ({
      id: `${scopeId}-ev-${i + 1}`,
      ts: new Date(t0 + i * 1000).toISOString(),
      actor,
      action,
      scope_kind: 'workflow_instance',
      scope_id: scopeId,
      resource_type,
      resource_id,
      rev,
      reason,
      payload,
      subject_hash: sha256Digest(canonicalize(payload)),
      recipe: 'jcs-sha256',
    });
    const user = { kind: 'user', id: 'u-operator-1' };
    const runtime = { kind: 'runtime', id: 'toy' };
    const items = [
      mk(0, user, 'run.started', 'workflow_instance', scopeId, 1, 'operator start', { workflow_oid: 'wf-pack-7', environment_oid: TOY_ROLES.environment_oid }),
      mk(1, runtime, 'step.invoked', 'step_instance', 'si-1', 1, 'scheduler', { action_oid: TOY_ROLES.observable_action, instance_id: 'inst-1' }),
      mk(2, runtime, 'step.state', 'step_instance', 'si-1', 2, 'container event', { instance_id: 'inst-1', state: 'EXECUTING', previous_state: 'STARTING' }),
      mk(3, runtime, 'step.done', 'step_instance', 'si-1', 3, 'container event', { instance_id: 'inst-1', state: 'COMPLETED' }),
      mk(4, user, 'run.completed', 'workflow_instance', scopeId, 2, 'all steps done', { steps: 1, outcome: 'COMPLETED' }),
    ];
    const events = [];
    let prev = '';
    items.forEach((item, i) => {
      const event = { ...item, prev_hash: prev, signature: '' };
      if (i === 2 && defects.has('break-chain')) event.prev_hash = sha256Digest('a link the toy never wrote');
      event.hash = eventHash(event);
      prev = event.hash;
      events.push(event);
    });
    return events;
  }

  /** POST /audit/verify {events:[...]} -> {data:{issues:[{index,id,issue}]}}. */
  function handleAuditVerify({ body }) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.events)) {
      return fail(400, 'VALIDATION_ERROR', 'body must be {events: [...]}');
    }
    let issues;
    try {
      issues = verifyChain(body.events);
    } catch (err) {
      // An event that cannot be canonicalized is unverifiable, not merely tampered.
      return fail(400, 'VALIDATION_ERROR', `events cannot be verified: ${err.message}`);
    }
    return ok(200, { issues, events: body.events.length });
  }

  /** GET /audit/export?scope_id=<id> -> application/x-ndjson, one event per line, no envelope. */
  function handleAuditExport({ url }) {
    const scopeId = url.searchParams.get('scope_id');
    if (!scopeId) return fail(400, 'VALIDATION_ERROR', 'scope_id is required');
    const lines = auditTrail(scopeId).map((e) => JSON.stringify(e)).join('\n') + '\n';
    return new Response(lines, { status: 200, headers: { 'content-type': 'application/x-ndjson', ...CORS_HEADERS } });
  }

  /**
   * POST /permission/decide {subject, verb, resource, grants, policy}
   * -> {data: {allowed, reason}}. Test-only probe (C-PRM-5): the toy exists
   * only to be tested, so it is the one place this surface is fine.
   */
  function handlePermissionDecide({ body }) {
    try {
      return ok(200, decidePermission(body, { permitSelfApproval: defects.has('permit-self-approval') }));
    } catch (err) {
      if (err instanceof PermissionRequestError) return fail(400, 'VALIDATION_ERROR', err.message);
      throw err;
    }
  }

  const PROBE_ROUTES = [
    ['POST', /^\/audit\/verify$/, handleAuditVerify],
    ['GET', /^\/audit\/export$/, handleAuditExport],
    ['POST', /^\/permission\/decide$/, handlePermissionDecide],
  ];

  function authorized(headers) {
    // no-auth: accept every request whether or not the key matches.
    if (defects.has('no-auth')) return true;
    return headers.get('x-api-key') === apiKey;
  }

  /**
   * forwarded-identity: when X-Trajectory-User is present the user token must
   * be valid (401 USER_UNAUTHORIZED) and the user must hold the grant
   * (403 FORBIDDEN). Both carry `details.user`; neither echoes the token, and
   * the token is dropped as soon as the check is done. No header: a plain
   * service call, as without the extension. The service key is checked first.
   */
  function checkForwardedIdentity(headers) {
    const raw = headers.get('x-trajectory-user');
    if (raw === null) return undefined;
    const m = /^Bearer (\S+)$/.exec(raw);
    const user = m ? TOY_USERS[m[1]] : undefined;
    if (!user) return fail(401, 'USER_UNAUTHORIZED', 'missing or invalid user token', { user: { subject: null } });
    if (!user.granted) return fail(403, 'FORBIDDEN', 'user has no grant for this action', { user: { subject: user.subject } });
    return undefined;
  }

  async function fetch(url, init = {}) {
    const u = new URL(String(url));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    let routes = ROUTES;
    let root = ROOT;
    if (u.pathname.startsWith(PROBE_ROOT)) {
      routes = PROBE_ROUTES;
      root = PROBE_ROOT;
    } else if (!u.pathname.startsWith(ROOT)) {
      return fail(404, 'NOT_FOUND', 'unknown path');
    }
    const path = u.pathname.slice(root.length) || '/';

    // CORS preflight answers for any known path; it is not in ROUTES so it cannot mask a 404.
    const pathKnown = routes.some(([, re]) => re.test(path));
    if (method === 'OPTIONS') return pathKnown ? handleOptions() : fail(404, 'NOT_FOUND', 'unknown path');
    const route = routes.find(([m, re]) => m === method && re.test(path));
    if (!route) {
      return pathKnown ? fail(405, 'METHOD_NOT_ALLOWED', 'method not allowed') : fail(404, 'NOT_FOUND', 'unknown path');
    }
    const [, re, handler, { auth = true } = {}] = route;
    if (auth && !authorized(headers)) return fail(401, 'UNAUTHORIZED', 'missing or invalid API key');
    if (auth && extensions.has('forwarded-identity')) {
      const denied = checkForwardedIdentity(headers);
      if (denied) return denied;
    }

    let body;
    if (init.body !== undefined && init.body !== null) {
      try {
        body = JSON.parse(typeof init.body === 'string' ? init.body : new TextDecoder().decode(init.body));
      } catch {
        return fail(400, 'VALIDATION_ERROR', 'body is not valid JSON');
      }
    }
    const params = re.exec(path).slice(1).map(decodeURIComponent);
    return handler({ url: u, method, headers, body, signal: init.signal }, params);
  }

  return { fetch, tick, defects, extensions, userTokens: TOY_USER_TOKENS, state: { instances, buses } };
}
