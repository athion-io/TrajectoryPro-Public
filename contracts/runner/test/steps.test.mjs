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

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { runStep, STEP_KINDS } from '../src/steps.mjs';
import { fakeClock } from './fake-clock.mjs';

const encoder = new TextEncoder();

function target(extra = {}) {
  return {
    name: 'stub',
    base_url: 'http://stub.test/trajectory/v1',
    auth: { mode: 'required', header: 'X-API-Key', scheme: '' },
    capabilities: ['observable_action', 'commands', 'sse'],
    roles: { environment_oid: 'env-1', observable_action: 'act-1' },
    timeouts: { wait_s: 15, sse_s: 10 },
    ...extra,
  };
}

function instanceBody(state) {
  return { data: { instance_id: 'inst-42', state: { current: state, previous: null, entered_at: 't' } } };
}

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function stateChange(id, state, previous = null) {
  return `id: ${id}\nevent: state_change\ndata: ${JSON.stringify({ instance_id: 'inst-42', state, previous_state: previous, timestamp: 't' })}\n\n`;
}

function sseResponse(chunks, { close = true } = {}) {
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      if (close) controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

/** Records every call as {path, method, headers, signal}; `handler(call, n)` returns a Response. */
function stubFetch(handler) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const call = { url: String(url), path: u.pathname.replace(/^\/trajectory\/v1/, '') + u.search, method: init.method ?? 'GET', headers: new Headers(init.headers), signal: init.signal };
    calls.push(call);
    return handler(call, calls.length);
  };
  fetch.calls = calls;
  return fetch;
}

function ctx({ fetch, clock = fakeClock({ auto: true }), target: t = target(), vars = {} } = {}) {
  return { target: t, vars: { roles: t.roles, uniq: 'u1', ...vars }, apiKey: 'secret-key', fetch, clock, log: () => {}, responses: new Map() };
}

describe('templated expect', () => {
  test('placeholders in expect values resolve from captured vars before grading', async () => {
    const fetch = stubFetch(() => jsonResponse(200, instanceBody('EXECUTING')));
    const step = { kind: 'request', method: 'GET', path: '/instances/{{iid}}', expect: { status: 200, json: [{ path: '$.data.instance_id', equals: '{{iid}}' }] } };
    const good = await runStep(step, ctx({ fetch, vars: { iid: 'inst-42' } }));
    assert.equal(good.check.outcome, 'pass', good.check.reason);
    const bad = await runStep(step, ctx({ fetch, vars: { iid: 'inst-7' } }));
    assert.equal(bad.check.outcome, 'fail');
    assert.match(bad.check.reason, /inst-42.*inst-7/);
  });

  test('a templated expected value is still redacted in the failure reason', async () => {
    const fetch = stubFetch(() => jsonResponse(200, instanceBody('EXECUTING')));
    const step = { kind: 'request', method: 'GET', path: '/instances/inst-42', expect: { json: [{ path: '$.data.instance_id', equals: '{{ref}}' }] } };
    const result = await runStep(step, ctx({ fetch, vars: { ref: 'inst-9?token=hunter2' } }));
    assert.equal(result.check.outcome, 'fail');
    assert.doesNotMatch(result.check.reason, /hunter2/);
    assert.match(result.check.reason, /token=\*\*\*/);
  });

  test('an unknown placeholder in expect is an error, not a silent pass', async () => {
    const fetch = stubFetch(() => jsonResponse(200, instanceBody('EXECUTING')));
    const step = { kind: 'request', method: 'GET', path: '/instances/inst-42', expect: { json: [{ path: '$.data.instance_id', equals: '{{nope}}' }] } };
    await assert.rejects(runStep(step, ctx({ fetch })), /nope/);
  });
});

describe('step kinds', () => {
  test('wait_state and sse_read are registered', () => {
    assert.deepEqual(Object.keys(STEP_KINDS).sort(), ['capture', 'request', 'sse_read', 'wait_state']);
  });
});

describe('wait_state', () => {
  test('succeeds after 3 polls with backoff through the clock', async () => {
    const fetch = stubFetch((_, n) => jsonResponse(200, instanceBody(n < 3 ? 'EXECUTING' : 'COMPLETED')));
    const c = ctx({ fetch, vars: { iid: 'inst-42' } });
    const result = await runStep({ kind: 'wait_state', instance: '{{iid}}', states: ['COMPLETED', 'ABORTED'] }, c);
    assert.equal(result.check.outcome, 'pass');
    assert.equal(fetch.calls.length, 3);
    assert.ok(fetch.calls.every((call) => call.method === 'GET' && call.path === '/instances/inst-42'), JSON.stringify(fetch.calls.map((x) => x.path)));
    assert.equal(fetch.calls[0].headers.get('x-api-key'), 'secret-key');
    assert.deepEqual(c.clock.sleeps, [250, 500]);
    assert.deepEqual(result.evidence, { method: 'GET', path: '/instances/inst-42', status: 200, code: null });
    assert.equal(result.response.json.data.state.current, 'COMPLETED');
  });

  test('fails naming the last state seen when the timeout passes', async () => {
    const fetch = stubFetch(() => jsonResponse(200, instanceBody('EXECUTING')));
    const c = ctx({ fetch });
    const result = await runStep({ kind: 'wait_state', instance: 'inst-42', states: ['COMPLETED'], timeout_s: 1 }, c);
    assert.equal(result.check.outcome, 'fail');
    assert.match(result.check.reason, /last seen EXECUTING/);
    assert.match(result.check.reason, /COMPLETED/);
    assert.match(result.check.reason, /1s/);
    // polls at 0, 0.25, 0.75 and 1.0 s: the last sleep is clipped to the deadline
    assert.deepEqual(c.clock.sleeps, [250, 500, 250]);
    assert.equal(fetch.calls.length, 4);
    assert.equal(result.evidence.status, 200);
  });

  test('backoff caps at 2 s and the target wait_s is the default bound', async () => {
    const fetch = stubFetch(() => jsonResponse(200, instanceBody('HELD')));
    const c = ctx({ fetch, target: target({ timeouts: { wait_s: 6 } }) });
    const result = await runStep({ kind: 'wait_state', instance: 'inst-42', states: ['COMPLETED'] }, c);
    assert.equal(result.check.outcome, 'fail');
    assert.match(result.check.reason, /within 6s/);
    assert.deepEqual(c.clock.sleeps, [250, 500, 1000, 2000, 2000, 250]);
  });

  test('defaults to 15 s when the target sets no timeouts', async () => {
    const fetch = stubFetch(() => jsonResponse(200, instanceBody('HELD')));
    const c = ctx({ fetch, target: target({ timeouts: undefined }) });
    const result = await runStep({ kind: 'wait_state', instance: 'inst-42', states: ['COMPLETED'] }, c);
    assert.match(result.check.reason, /within 15s/);
    assert.equal(c.clock.sleeps.reduce((a, b) => a + b, 0), 15_000);
  });

  test('keeps polling through an error response and reports it as last seen', async () => {
    const fetch = stubFetch((_, n) => (n === 1 ? jsonResponse(404, { error: { code: 'INSTANCE_NOT_FOUND', message: 'no' } }) : jsonResponse(200, instanceBody('EXECUTING'))));
    const c = ctx({ fetch });
    const result = await runStep({ kind: 'wait_state', instance: 'inst-42', states: ['COMPLETED'], timeout_s: 0.2 }, c);
    assert.equal(result.check.outcome, 'fail');
    assert.match(result.check.reason, /last seen EXECUTING/);
    const onlyErrors = stubFetch(() => jsonResponse(404, { error: { code: 'INSTANCE_NOT_FOUND', message: 'no' } }));
    const r2 = await runStep({ kind: 'wait_state', instance: 'inst-42', states: ['COMPLETED'], timeout_s: 0.2 }, ctx({ fetch: onlyErrors }));
    assert.match(r2.check.reason, /last seen HTTP 404 INSTANCE_NOT_FOUND/);
    assert.equal(r2.evidence.code, 'INSTANCE_NOT_FOUND');
  });

  test('stores the response by id and applies capture on success', async () => {
    const fetch = stubFetch(() => jsonResponse(200, instanceBody('COMPLETED')));
    const c = ctx({ fetch });
    await runStep({ kind: 'wait_state', id: 'done', instance: 'inst-42', states: ['COMPLETED'], capture: { final: '$.data.state.current' } }, c);
    assert.equal(c.vars.final, 'COMPLETED');
    assert.equal(c.responses.get('done').status, 200);
  });

  test('rejects a step without states and a fetch failure surfaces as an error', async () => {
    await assert.rejects(runStep({ kind: 'wait_state', instance: 'inst-42' }, ctx({ fetch: stubFetch() })), /states/);
    const fetch = stubFetch(() => { throw new Error('ECONNREFUSED'); });
    await assert.rejects(runStep({ kind: 'wait_state', instance: 'inst-42', states: ['COMPLETED'] }, ctx({ fetch })), /GET \/instances\/inst-42 failed: ECONNREFUSED/);
  });

  test('the timeout reason, evidence and errors keep the path redacted', async () => {
    const fetch = stubFetch(() => jsonResponse(200, instanceBody('EXECUTING')));
    const result = await runStep({ kind: 'wait_state', instance: 'inst-42?token=hunter2', states: ['COMPLETED'], timeout_s: 0.2 }, ctx({ fetch }));
    assert.equal(result.check.outcome, 'fail');
    assert.match(result.check.reason, /wait_state: \/instances\/inst-42\?token=\*\*\* did not reach COMPLETED/);
    assert.doesNotMatch(result.check.reason, /hunter2/);
    assert.equal(result.evidence.path, '/instances/inst-42?token=***');
    const failing = stubFetch(() => { throw new Error('ECONNRESET'); });
    await assert.rejects(runStep({ kind: 'wait_state', instance: 'inst-42?token=hunter2', states: ['COMPLETED'] }, ctx({ fetch: failing })), (err) => /ECONNRESET/.test(err.message) && !/hunter2/.test(err.message));
  });
});

describe('sse_read', () => {
  test('reads until the terminal state, captures the events and aborts the body', async () => {
    const fetch = stubFetch(() => sseResponse([stateChange(0, 'STARTING'), stateChange(1, 'EXECUTING', 'STARTING'), stateChange(2, 'COMPLETED', 'EXECUTING'), stateChange(3, 'GHOST')], { close: false }));
    const c = ctx({ fetch, clock: fakeClock(), vars: { iid: 'inst-42' } });
    const step = {
      kind: 'sse_read',
      id: 'stream',
      instance: '{{iid}}',
      max: 10,
      until_state: ['COMPLETED', 'ABORTED', 'STOPPED'],
      capture_events: 'seen',
      expect: { status: 200, headers: { 'content-type': { contains_token: 'text/event-stream' } }, json: [{ path: '$.events[*].event', equals: 'state_change' }, { path: '$.ended', equals: 'state' }] },
    };
    const result = await runStep(step, c);
    assert.equal(result.check.outcome, 'pass', result.check.reason);
    assert.equal(fetch.calls[0].path, '/instances/inst-42/events');
    assert.equal(fetch.calls[0].headers.get('accept'), 'text/event-stream');
    assert.equal(fetch.calls[0].headers.get('x-api-key'), 'secret-key');
    assert.equal(fetch.calls[0].headers.has('last-event-id'), false);
    assert.ok(fetch.calls[0].signal instanceof AbortSignal, 'request carries a signal');
    assert.equal(fetch.calls[0].signal.aborted, true, 'body aborted when done');
    assert.deepEqual(c.vars.seen.map((e) => e.data.state), ['STARTING', 'EXECUTING', 'COMPLETED']);
    assert.deepEqual(result.response.json.events, c.vars.seen);
    assert.equal(result.response.json.ended, 'state');
    assert.deepEqual(result.evidence, { method: 'GET', path: '/instances/inst-42/events', status: 200, code: null });
    assert.equal(c.responses.get('stream').json.events.length, 3);
  });

  test('sends Last-Event-ID and stops at max', async () => {
    const fetch = stubFetch(() => sseResponse([stateChange(5, 'EXECUTING'), stateChange(6, 'HELD'), stateChange(7, 'EXECUTING')]));
    const c = ctx({ fetch, clock: fakeClock(), vars: { last: 4 } });
    const result = await runStep({ kind: 'sse_read', instance: 'inst-42', last_event_id: '{{last}}', max: 2, capture_events: 'ev' }, c);
    assert.equal(fetch.calls[0].headers.get('last-event-id'), '4');
    assert.deepEqual(c.vars.ev.map((e) => e.id), [5, 6]);
    assert.equal(result.response.json.ended, 'count');
  });

  test('times out through the clock on a stream that never ends', async () => {
    const fetch = stubFetch(() => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const clock = fakeClock();
    const c = ctx({ fetch, clock });
    const pending = runStep({ kind: 'sse_read', instance: 'inst-42', max: 1, timeout_s: 2, capture_events: 'ev', expect: { json: [{ path: '$.ended', in: ['count', 'state'] }] } }, c);
    await clock.tick(0);
    assert.deepEqual(clock.sleeps, [2000]);
    await clock.tick(2000);
    const result = await pending;
    assert.equal(result.response.json.ended, 'timeout');
    assert.deepEqual(c.vars.ev, []);
    assert.equal(result.check.outcome, 'fail');
    assert.match(result.check.reason, /ended/);
    assert.equal(fetch.calls[0].signal.aborted, true);
  });

  test('uses the target sse_s as the bound, then 15 s when the target sets none', async () => {
    const silent = () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    const a = fakeClock();
    const pa = runStep({ kind: 'sse_read', instance: 'inst-42', max: 1 }, ctx({ fetch: stubFetch(silent), clock: a, target: target({ timeouts: { sse_s: 3 } }) }));
    // the sleep is armed after the (async) fetch resolves, so let that happen first
    await a.tick(0);
    await a.tick(3000);
    assert.equal((await pa).response.json.ended, 'timeout');
    assert.deepEqual(a.sleeps, [3000]);
    const b = fakeClock();
    const pb = runStep({ kind: 'sse_read', instance: 'inst-42', max: 1 }, ctx({ fetch: stubFetch(silent), clock: b, target: target({ timeouts: undefined }) }));
    await b.tick(0);
    await b.tick(15_000);
    assert.equal((await pb).response.json.ended, 'timeout');
    assert.deepEqual(b.sleeps, [15_000]);
  });

  test('a non-200 response is graded like a request and records error.code', async () => {
    const fetch = stubFetch(() => jsonResponse(404, { error: { code: 'INSTANCE_NOT_FOUND', message: 'no' } }));
    const result = await runStep({ kind: 'sse_read', instance: 'inst-42', max: 1, expect: { status: 404, json: [{ path: '$.error.code', equals: 'INSTANCE_NOT_FOUND' }] } }, ctx({ fetch, clock: fakeClock() }));
    assert.equal(result.check.outcome, 'pass', result.check.reason);
    assert.equal(result.evidence.code, 'INSTANCE_NOT_FOUND');
    assert.equal(result.response.json.error.code, 'INSTANCE_NOT_FOUND');
  });

  test('evidence and errors keep the path redacted', async () => {
    const fetch = stubFetch(() => sseResponse([stateChange(0, 'COMPLETED')]));
    const result = await runStep({ kind: 'sse_read', instance: 'inst-42?token=hunter2', max: 1 }, ctx({ fetch, clock: fakeClock() }));
    assert.doesNotMatch(result.evidence.path, /hunter2/);
    const failing = stubFetch(() => { throw new Error('ECONNRESET'); });
    await assert.rejects(runStep({ kind: 'sse_read', instance: 'inst-42?token=hunter2', max: 1 }, ctx({ fetch: failing })), (err) => /ECONNRESET/.test(err.message) && !/hunter2/.test(err.message));
  });
});
