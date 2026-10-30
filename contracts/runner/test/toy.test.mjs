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

import { makeToy } from './toy-container.mjs';
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
    const inv = await call(t, 'POST', '/environments/env-c1/actions/act-hold/invoke', invokeBody());
    assert.equal(inv.status, 201);
    const id = inv.json.data.instance_id;
    assert.equal(typeof id, 'string');

    let got = await call(t, 'GET', `/instances/${id}`);
    assert.equal(got.json.data.state.current, 'STARTING');

    await t.tick(100);
    got = await call(t, 'GET', `/instances/${id}`);
    assert.equal(got.json.data.state.current, 'EXECUTING');
    assert.equal(got.json.data.state.previous, 'STARTING');
  });

  test('PAUSE moves EXECUTING to PAUSED after a tick', async () => {
    const t = toy();
    const inv = await call(t, 'POST', '/environments/env-c1/actions/act-hold/invoke', invokeBody());
    const id = inv.json.data.instance_id;
    await t.tick(100);

    const cmd = await call(t, 'POST', `/instances/${id}/commands`, { command: 'PAUSE' });
    assert.equal(cmd.status, 200);
    assert.deepEqual(cmd.json.data, { instance_id: id, command: 'PAUSE', accepted: true });

    await t.tick(100);
    const got = await call(t, 'GET', `/instances/${id}`);
    assert.equal(got.json.data.state.current, 'PAUSED');
  });
});
