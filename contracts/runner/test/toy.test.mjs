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

// Smoke tests for the in-process reference toy container. Later tasks add
// fixture-driven coverage; these only prove the toy answers the runner's
// basic request shapes without sockets or real timers.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { makeToy, FAST_COMPLETING_TICKS } from './toy-container.mjs';
import { fakeClock } from './fake-clock.mjs';

const BASE = 'http://toy.test/trajectory/v1';

function toy(opts = {}) {
  return makeToy({ apiKey: 'k', clock: fakeClock({ start: 1_000 }), ...opts });
}

async function call(t, method, path, body) {
  const init = { method, headers: { 'x-api-key': 'k', accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await t.fetch(BASE + path, init);
  return { status: res.status, headers: res.headers, json: await res.json() };
}

function invokeBody(n = 1) {
  return {
    environment_oid: 'env-c1',
    workflow_instance_id: `wf-${n}`,
    step_instance_id: `step-${n}`,
    step_oid: 'step-oid',
    input_parameters: [],
  };
}

const INVOKE = '/actions/act-hold/invoke';

/** Read every SSE frame the toy has queued so far, then cancel the stream. */
async function drainSse(res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  // The stream never closes on its own; read until a read would block.
  for (;;) {
    const next = reader.read();
    const r = await Promise.race([next, new Promise((resolve) => setImmediate(() => resolve({ timeout: true })))]);
    if (r.timeout || r.done) break;
    text += decoder.decode(r.value);
  }
  await reader.cancel();
  return text.split('\n\n').filter(Boolean).map((block) => {
    const f = {};
    for (const line of block.split('\n')) {
      const i = line.indexOf(': ');
      f[line.slice(0, i)] = line.slice(i + 2);
    }
    return { id: Number(f.id), event: f.event, data: JSON.parse(f.data) };
  });
}

describe('toy container smoke', () => {
  test('health is ok', async () => {
    const t = toy();
    const r = await call(t, 'GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, 'ok');
    assert.equal(typeof r.json.data.timestamp, 'string');
    assert.deepEqual(r.json.meta, {});
  });

  test('invoking the observable action reaches EXECUTING after a tick', async () => {
    const t = toy();
    const inv = await call(t, 'POST', INVOKE, invokeBody());
    assert.equal(inv.status, 201);
    const id = inv.json.data.instance_id;
    assert.equal(typeof id, 'string');

    let got = await call(t, 'GET', `/instances/${id}`);
    assert.equal(got.json.data.state.current, 'STARTING');
    assert.deepEqual(got.json.data.outputs, []);

    await t.tick(100);
    got = await call(t, 'GET', `/instances/${id}`);
    assert.equal(got.json.data.state.current, 'EXECUTING');
    assert.equal(got.json.data.state.previous, 'STARTING');
  });

  test('PAUSE moves EXECUTING to PAUSED after a tick', async () => {
    const t = toy();
    const inv = await call(t, 'POST', INVOKE, invokeBody());
    const id = inv.json.data.instance_id;
    await t.tick(100);

    const cmd = await call(t, 'POST', `/instances/${id}/command`, { command: 'PAUSE' });
    assert.equal(cmd.status, 200);
    assert.deepEqual(cmd.json.data, { instance_id: id, command: 'PAUSE', accepted: true });

    await t.tick(100);
    const got = await call(t, 'GET', `/instances/${id}`);
    assert.equal(got.json.data.state.current, 'PAUSED');
  });

  test('invoke: unknown action is 404 NOT_FOUND, unknown environment in body is 404 NOT_FOUND', async () => {
    const t = toy();
    const bad = await call(t, 'POST', '/actions/act-nope/invoke', invokeBody());
    assert.equal(bad.status, 404);
    assert.equal(bad.json.error.code, 'NOT_FOUND');

    const env = await call(t, 'POST', INVOKE, { ...invokeBody(), environment_oid: 'env-nope' });
    assert.equal(env.status, 404);
    assert.equal(env.json.error.code, 'NOT_FOUND');

    const old = await call(t, 'POST', '/environments/env-c1/actions/act-hold/invoke', invokeBody());
    assert.equal(old.status, 404);
  });

  test('capabilities follow the REST-02 shape', async () => {
    const t = toy();
    const r = await call(t, 'GET', '/capabilities');
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.json.data), ['environments']);
    const env = r.json.data.environments[0];
    assert.equal(env.environment_oid, 'env-c1');
    assert.equal(typeof env.environment_name, 'string');
    assert.equal(env.environment_state, 'Effective');
    assert.deepEqual(env.action_properties, []);
    for (const a of env.actions) {
      for (const k of ['action_oid', 'action_name', 'action_state', 'local_id', 'version', 'description', 'visibility']) {
        assert.equal(typeof a[k], 'string', `${a.action_oid}.${k}`);
      }
      assert.ok(Array.isArray(a.input_parameters));
      assert.ok(Array.isArray(a.output_parameters));
      assert.deepEqual(a.supported_commands, a.visibility === 'opaque' ? ['ABORT'] : ['PAUSE', 'RESUME', 'HOLD', 'UNHOLD', 'ABORT', 'STOP', 'CLEAR']);
    }
    assert.deepEqual(r.json.meta, { total_environments: 1, total_actions: env.actions.length });
  });

  test('outputs are a {name,value} array in the instance and in the output event', async () => {
    const t = toy();
    const inv = await call(t, 'POST', '/actions/act-fast/invoke', invokeBody());
    const id = inv.json.data.instance_id;
    const sse = await t.fetch(`${BASE}/instances/${id}/events`, { headers: { 'x-api-key': 'k' } });
    await t.tick(FAST_COMPLETING_TICKS + 2);

    const got = await call(t, 'GET', `/instances/${id}`);
    assert.equal(got.json.data.state.current, 'COMPLETED');
    assert.ok(Array.isArray(got.json.data.outputs) && got.json.data.outputs.length > 0);
    for (const o of got.json.data.outputs) assert.deepEqual(Object.keys(o), ['name', 'value']);

    const frames = await drainSse(sse);
    const output = frames.find((f) => f.event === 'output');
    assert.deepEqual(output.data.outputs, got.json.data.outputs);
    assert.equal(frames.at(-1).event, 'state_change');
    assert.equal(frames.at(-1).data.state, 'COMPLETED');
  });

  test('act-fast shows a COMPLETING window in which HOLD is 409 but ABORT is accepted', async () => {
    const t = toy();
    const inv = await call(t, 'POST', '/actions/act-fast/invoke', invokeBody());
    const id = inv.json.data.instance_id;
    await t.tick(2);
    assert.equal((await call(t, 'GET', `/instances/${id}`)).json.data.state.current, 'COMPLETING');

    const hold = await call(t, 'POST', `/instances/${id}/command`, { command: 'HOLD' });
    assert.equal(hold.status, 409);
    assert.equal(hold.json.error.code, 'INVALID_STATE_TRANSITION');

    await t.tick(FAST_COMPLETING_TICKS);
    assert.equal((await call(t, 'GET', `/instances/${id}`)).json.data.state.current, 'COMPLETED');

    const t2 = toy();
    const id2 = (await call(t2, 'POST', '/actions/act-fast/invoke', invokeBody())).json.data.instance_id;
    await t2.tick(2);
    assert.equal((await call(t2, 'POST', `/instances/${id2}/command`, { command: 'ABORT' })).status, 200);
    await t2.tick(2);
    assert.equal((await call(t2, 'GET', `/instances/${id2}`)).json.data.state.current, 'ABORTED');
  });

  test('an opaque instance has no event stream: 404 NOT_FOUND in the error envelope', async () => {
    const t = toy();
    const id = (await call(t, 'POST', '/actions/act-opaque/invoke', invokeBody())).json.data.instance_id;
    const r = await call(t, 'GET', `/instances/${id}/events`);
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'NOT_FOUND');
    assert.equal((await call(t, 'GET', `/instances/${id}`)).status, 200);
  });

  test('CLEAR after ABORTED emits no event past the terminal state_change', async () => {
    const t = toy();
    const inv = await call(t, 'POST', INVOKE, invokeBody());
    const id = inv.json.data.instance_id;
    const sse = await t.fetch(`${BASE}/instances/${id}/events`, { headers: { 'x-api-key': 'k' } });
    await t.tick(100);
    await call(t, 'POST', `/instances/${id}/command`, { command: 'ABORT' });
    await t.tick(100);
    assert.equal((await call(t, 'GET', `/instances/${id}`)).json.data.state.current, 'ABORTED');

    const clr = await call(t, 'POST', `/instances/${id}/command`, { command: 'CLEAR' });
    assert.equal(clr.status, 200);
    await t.tick(100);

    const frames = await drainSse(sse);
    assert.equal(frames.at(-1).event, 'state_change');
    assert.equal(frames.at(-1).data.state, 'ABORTED');
    assert.equal((await call(t, 'GET', `/instances/${id}`)).status, 404);
  });

  test('SSE: no replay without Last-Event-ID, replay of id > N with it', async () => {
    const t = toy();
    const inv = await call(t, 'POST', INVOKE, invokeBody());
    const id = inv.json.data.instance_id;
    await t.tick(100); // ids 0 (STARTING) and 1 (EXECUTING) are buffered

    const fresh = await t.fetch(`${BASE}/instances/${id}/events`, { headers: { 'x-api-key': 'k' } });
    assert.deepEqual(await drainSse(fresh), []);

    const resumed = await t.fetch(`${BASE}/instances/${id}/events`, { headers: { 'x-api-key': 'k', 'last-event-id': '0' } });
    assert.deepEqual((await drainSse(resumed)).map((f) => [f.id, f.data.state]), [[1, 'EXECUTING']]);
  });

  test('unknown path is 404, known path with wrong method is 405', async () => {
    const t = toy();
    assert.equal((await call(t, 'GET', '/nope')).status, 404);
    assert.equal((await call(t, 'GET', '/nope')).json.error.code, 'NOT_FOUND');
    assert.equal((await call(t, 'PUT', '/health')).status, 405);
    const opt = await t.fetch(`${BASE}/health`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
  });

  test('unknown defect name throws', () => {
    assert.throws(() => makeToy({ defects: ['no-such-defect'] }), /no-such-defect/);
    assert.doesNotThrow(() => makeToy({ defects: ['no-auth', 'bad-envelope'] }));
  });

  test('accept-any-command accepts an unknown command name with 200', async () => {
    const t = toy({ defects: ['accept-any-command'] });
    const inv = await call(t, 'POST', INVOKE, invokeBody());
    const id = inv.json.data.instance_id;
    const r = await call(t, 'POST', `/instances/${id}/command`, { command: 'DANCE' });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.accepted, true);
  });
});
