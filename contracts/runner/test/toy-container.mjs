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
//   accept-any-command     commands are accepted regardless of state
//   no-auth                X-API-Key is not checked
//   non-idempotent-invoke  re-invoking the same step creates a new instance
//   no-ring-replay         Last-Event-ID is ignored; no buffered replay
//   break-chain            audit trail hash chain is broken (probe surface, later task)
//   lying-readback         permission read-back differs from what was granted (later task)
//   permit-self-approval   approver may equal requester (later task)
// Later tasks add the /conformance/v1/* probe surface and may add defects;
// add routes to ROUTES and consult `defects.has(...)` at the point of failure.

const ROOT = '/trajectory/v1';
const RING_SIZE = 256;

/** Toy roles that the target file refers to. */
export const TOY_ROLES = Object.freeze({
  environment_oid: 'env-c1',
  observable_action: 'act-hold',
  opaque_action: 'act-opaque',
  fast_action: 'act-fast',
  offline_action: 'act-offline',
  unknown_action: 'act-nope',
  guarded_action: 'act-guarded',
});

const ACTIONS = {
  'act-hold': { visibility: 'observable', description: 'Holds in EXECUTING until commanded' },
  'act-opaque': { visibility: 'opaque', description: 'Completes on its own after a few ticks' },
  'act-fast': { visibility: 'observable', description: 'Completes one tick after invoke' },
  'act-offline': { visibility: 'observable', description: 'Agent is unavailable', offline: true },
  'act-guarded': { visibility: 'observable', description: 'Guarded by a permission (later task)' },
};

export const COMMANDS = ['PAUSE', 'RESUME', 'HOLD', 'UNHOLD', 'ABORT', 'STOP', 'CLEAR'];

/** REST_Protocol §3: which commands are valid in which state. */
const VALID_COMMANDS = {
  POSTED: ['ABORT'],
  RECEIVED: ['ABORT'],
  IN_PROGRESS: ['ABORT'],
  STARTING: ['ABORT', 'STOP'],
  EXECUTING: ['PAUSE', 'HOLD', 'ABORT', 'STOP'],
  PAUSED: ['RESUME', 'ABORT', 'STOP'],
  HELD: ['UNHOLD', 'ABORT', 'STOP'],
  ABORTED: ['CLEAR'],
};

/** command -> [transient state, settled state] */
const COMMAND_PATH = {
  PAUSE: ['PAUSING', 'PAUSED'],
  RESUME: ['RESUMING', 'EXECUTING'],
  HOLD: ['HOLDING', 'HELD'],
  UNHOLD: ['UNHOLDING', 'EXECUTING'],
  STOP: ['STOPPING', 'STOPPED'],
  ABORT: ['ABORTING', 'ABORTED'],
  CLEAR: [null, 'IDLE'],
};

const TERMINAL = new Set(['COMPLETED', 'STOPPED', 'ABORTED', 'FAILED', 'IDLE']);

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS',
  'access-control-allow-headers': 'Content-Type, X-API-Key, Last-Event-ID',
  'access-control-expose-headers': 'Content-Type',
};

/**
 * @param {{apiKey?: string, defects?: Set<string>|string[], clock?: {now(): number}}} [opts]
 * @returns {{fetch(url: string|URL, init?: RequestInit): Promise<Response>, tick(ms: number): Promise<void>, defects: Set<string>, state: object}}
 */
export function makeToy({ apiKey = 'k', defects = new Set(), clock } = {}) {
  defects = defects instanceof Set ? defects : new Set(defects);
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
      b = { events: [], nextId: 0, subscribers: new Set() };
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
      // Same tick as EXECUTING, so one tick() sees STARTING -> EXECUTING -> COMPLETED.
      schedule(1, () => inst.state.current === 'EXECUTING' && complete(inst));
    }
  }

  function complete(inst) {
    inst.outputs = { result: 'ok', echo: inst.inputs };
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
    return ok(200, {
      container: { name: 'reference-toy', version: '0.1.0', protocol: 'trajectory/v1' },
      environments: [{
        environment_oid: TOY_ROLES.environment_oid,
        name: 'Toy environment',
        actions: Object.entries(ACTIONS).map(([action_oid, a]) => ({
          action_oid,
          name: action_oid,
          description: a.description,
          visibility: a.visibility,
          supported_commands: a.visibility === 'opaque' ? ['ABORT'] : COMMANDS,
          input_parameters: [],
        })),
      }],
    });
  }

  function handleInvoke(req, [envOid, actionOid]) {
    const action = ACTIONS[actionOid];
    if (envOid !== TOY_ROLES.environment_oid || !action) {
      return fail(404, 'NOT_FOUND', 'unknown environment or action', { environment_oid: envOid, action_oid: actionOid });
    }
    const body = req.body;
    if (!body || typeof body !== 'object') return fail(400, 'VALIDATION_ERROR', 'body must be a JSON object');
    const missing = ['environment_oid', 'workflow_instance_id', 'step_instance_id', 'step_oid', 'input_parameters']
      .filter((k) => body[k] === undefined || body[k] === null);
    if (missing.length || !Array.isArray(body.input_parameters)) {
      return fail(400, 'VALIDATION_ERROR', 'missing or invalid fields', { missing, input_parameters: Array.isArray(body.input_parameters) ? 'ok' : 'must be an array' });
    }
    if (body.environment_oid !== envOid) {
      return fail(400, 'VALIDATION_ERROR', 'environment_oid does not match path', { path: envOid, body: body.environment_oid });
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
      outputs: null,
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
    if (typeof command !== 'string' || !COMMANDS.includes(command)) {
      return fail(422, 'INVALID_COMMAND', 'unknown command', { command, supported: COMMANDS });
    }
    const current = inst.state.current;
    const valid = VALID_COMMANDS[current] ?? [];
    // accept-any-command: skip the §3 validity table and accept in every state.
    if (!defects.has('accept-any-command') && !valid.includes(command)) {
      return fail(409, 'INVALID_STATE_TRANSITION', `${command} is not valid in state ${current}`, { state: current, valid_commands: valid });
    }
    const [transient, settled] = COMMAND_PATH[command];
    if (transient) {
      setState(inst, transient);
      schedule(1, () => inst.state.current === transient && setState(inst, settled));
    } else {
      setState(inst, settled);
    }
    return ok(200, { instance_id: id, command, accepted: true });
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
    const b = bus(id);
    const encoder = new TextEncoder();
    const lastHeader = req.headers.get('last-event-id');
    const lastId = lastHeader !== null && /^\d+$/.test(lastHeader) ? Number(lastHeader) : null;
    const frame = (f) => encoder.encode(`id: ${f.id}\nevent: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`);

    let subscriber;
    const body = new ReadableStream({
      start(controller) {
        // no-ring-replay: ignore Last-Event-ID and send nothing from the buffer.
        if (!defects.has('no-ring-replay')) {
          const replay = lastId === null ? b.events : b.events.filter((f) => f.id > lastId);
          for (const f of replay) controller.enqueue(frame(f));
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

  /** Route table: [method, path regex relative to ROOT, handler, {auth}] */
  const ROUTES = [
    ['OPTIONS', /^.*$/, handleOptions, { auth: false }],
    ['GET', /^\/health$/, handleHealth, { auth: false }],
    ['GET', /^\/capabilities$/, handleCapabilities],
    ['POST', /^\/environments\/([^/]+)\/actions\/([^/]+)\/invoke$/, handleInvoke],
    ['GET', /^\/instances$/, handleListInstances],
    ['GET', /^\/instances\/([^/]+)$/, handleGetInstance],
    ['POST', /^\/instances\/([^/]+)\/commands$/, handleCommand],
    ['DELETE', /^\/instances\/([^/]+)$/, handleDelete],
    ['GET', /^\/instances\/([^/]+)\/events$/, handleEvents],
  ];

  function authorized(headers) {
    // no-auth: accept every request whether or not the key matches.
    if (defects.has('no-auth')) return true;
    return headers.get('x-api-key') === apiKey;
  }

  async function fetch(url, init = {}) {
    const u = new URL(String(url));
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    if (!u.pathname.startsWith(ROOT)) return fail(404, 'NOT_FOUND', 'unknown path');
    const path = u.pathname.slice(ROOT.length) || '/';

    const route = ROUTES.find(([m, re]) => m === method && re.test(path));
    if (!route) {
      const pathKnown = ROUTES.some(([, re]) => re.test(path));
      return pathKnown ? fail(405, 'METHOD_NOT_ALLOWED', 'method not allowed') : fail(404, 'NOT_FOUND', 'unknown path');
    }
    const [, re, handler, { auth = true } = {}] = route;
    if (auth && !authorized(headers)) return fail(401, 'UNAUTHORIZED', 'missing or invalid API key');

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

  return { fetch, tick, defects, state: { instances, buses } };
}
