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

import { runSuite, exitCode } from '../src/run.mjs';

function target(extra = {}) {
  return {
    name: 'stub',
    base_url: 'http://stub.test/trajectory/v1',
    probe_url: 'http://stub.test/conformance/v1',
    auth: { mode: 'required', header: 'X-API-Key', scheme: '' },
    capabilities: ['observable_action', 'commands'],
    extensions: ['change-guard'],
    roles: { environment_oid: 'env-1', observable_action: 'act-1', fast_action: 'act-fast' },
    timeouts: { wait_s: 15, sse_s: 10 },
    known_failures: {},
    ...extra,
  };
}

function fixture(extra = {}) {
  return {
    test_id: 'agt-001',
    name: 'Invoke returns an instance id',
    category: 'agent-action',
    level: 'MUST',
    source: 'REST-05',
    tags: ['invoke'],
    requires: ['observable_action'],
    steps: [
      {
        kind: 'request',
        method: 'POST',
        path: '/actions/{{roles.observable_action}}/invoke',
        body: { environment_oid: '{{roles.environment_oid}}', workflow_instance_id: '{{uniq}}-wf' },
        expect: { status: 202, json: [{ path: '$.data.instance_id', present: true }] },
      },
    ],
    ...extra,
  };
}

const INVOKE = { status: 202, body: { data: { instance_id: 'inst-42', state: 'EXECUTING' } } };

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

const BASE_PATH = /^\/(trajectory|conformance)\/v1/;

/**
 * A fetch stub. `handler(req)` gets {url, path, method, headers, body} and returns
 * either a Response or {status, body, headers}. Every request is recorded in `calls`.
 * `path` is relative to the target's base_url / probe_url.
 */
function stubFetch(handler = () => INVOKE) {
  const calls = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    const req = {
      url: String(url),
      path: u.pathname.replace(BASE_PATH, '') + u.search,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: init.body === undefined ? undefined : JSON.parse(init.body),
    };
    calls.push(req);
    const r = await handler(req, calls.length);
    return r instanceof Response ? r : jsonResponse(r.status ?? 200, r.body ?? {}, r.headers);
  };
  fetch.calls = calls;
  return fetch;
}

const clock = { now: () => 1_700_000_000_000, sleep: async () => {} };

async function run(fixtures, { target: t = target(), fetch = stubFetch(), log = () => {}, ...rest } = {}) {
  const report = await runSuite({ fixtures, target: t, apiKey: 'secret-key', fetch, clock, log, ...rest });
  return { report, fetch, result: report.results[0] };
}

describe('runSuite: report shape', () => {
  test('a passing fixture is reported with evidence and no bodies', async () => {
    const { report, result, fetch } = await run([fixture()], { fixturesCommit: 'abc1234' });
    assert.equal(report.target, 'stub');
    assert.equal(typeof report.runner_version, 'string');
    assert.equal(report.fixtures_commit, 'abc1234');
    assert.equal(report.started_at, new Date(clock.now()).toISOString());
    assert.deepEqual(report.totals, { pass: 1, fail: 0, note: 0, skip: 0 });
    assert.deepEqual(result, {
      test_id: 'agt-001',
      level: 'MUST',
      outcome: 'pass',
      reason: '',
      evidence: [{ method: 'POST', path: '/actions/act-1/invoke', status: 202, code: null }],
    });
    assert.equal(fetch.calls[0].headers.get('x-api-key'), 'secret-key');
    assert.equal(fetch.calls[0].body.environment_oid, 'env-1');
    assert.doesNotMatch(JSON.stringify(report), /inst-42/);
  });

  test('evidence records error.code and results stay in fixture order', async () => {
    const fetch = stubFetch(() => ({ status: 400, body: { error: { code: 'VALIDATION_ERROR' } } }));
    const b = fixture({ test_id: 'agt-002' });
    const { report } = await run([fixture(), b], { fetch });
    assert.deepEqual(report.results.map((r) => r.test_id), ['agt-001', 'agt-002']);
    assert.equal(report.results[0].outcome, 'fail');
    assert.equal(report.results[0].evidence[0].code, 'VALIDATION_ERROR');
    assert.deepEqual(report.totals, { pass: 0, fail: 2, note: 0, skip: 0 });
  });

  test('log gets one line per fixture', async () => {
    const lines = [];
    await run([fixture()], { log: (l) => lines.push(l) });
    assert.ok(lines.some((l) => /agt-001/.test(l) && /pass/.test(l)), JSON.stringify(lines));
  });
});

describe('runSuite: variables', () => {
  test('capture fills {{name}} for later steps', async () => {
    const f = fixture({
      setup: [
        {
          kind: 'request',
          id: 'inv',
          method: 'POST',
          path: '/actions/{{roles.observable_action}}/invoke',
          body: {},
          capture: { iid: '$.data.instance_id' },
        },
      ],
      steps: [{ kind: 'request', method: 'POST', path: '/instances/{{iid}}/command', body: { command: 'HOLD' }, expect: { status: 202 } }],
    });
    const { result, fetch } = await run([f]);
    assert.equal(result.outcome, 'pass');
    assert.equal(fetch.calls[1].path, '/instances/inst-42/command');
  });

  test('a capture step pulls values out of an earlier response by id', async () => {
    const f = fixture({
      setup: [
        { kind: 'request', id: 'inv', method: 'POST', path: '/actions/{{roles.observable_action}}/invoke', body: {} },
        { kind: 'capture', from: 'inv', capture: { st: '$.data.state' } },
      ],
      steps: [{ kind: 'request', path: '/instances/x?state={{st}}', expect: { status: 202 } }],
    });
    const { result, fetch } = await run([f]);
    assert.equal(result.outcome, 'pass', result.reason);
    assert.equal(fetch.calls[1].path, '/instances/x?state=EXECUTING');
  });

  test('a capture with nothing at the path is a setup failure', async () => {
    const f = fixture({
      setup: [{ kind: 'request', method: 'POST', path: '/x', body: {}, capture: { iid: '$.data.nope' } }],
    });
    const { result } = await run([f]);
    assert.equal(result.outcome, 'fail');
    assert.match(result.reason, /^setup:/);
    assert.match(result.reason, /iid/);
  });

  test('{{uniq}} is the same within a fixture and different across fixtures', async () => {
    const step = { kind: 'request', method: 'POST', path: '/x', body: { wf: '{{uniq}}-wf' }, expect: { status: 202 } };
    const a = fixture({ steps: [step, step] });
    const b = fixture({ test_id: 'agt-002', steps: [step] });
    const { fetch } = await run([a, b]);
    const [a1, a2, b1] = fetch.calls.map((c) => c.body.wf);
    assert.equal(a1, a2);
    assert.notEqual(a1, b1);
    assert.match(a1, /-wf$/);
  });

  test('an unknown placeholder fails the fixture naming it', async () => {
    const f = fixture({ steps: [{ kind: 'request', path: '/instances/{{never_captured}}', expect: { status: 200 } }] });
    const { result } = await run([f]);
    assert.equal(result.outcome, 'fail');
    assert.match(result.reason, /never_captured/);
  });
});

describe('runSuite: skip', () => {
  test('a missing capability skips without any request', async () => {
    const { result, fetch } = await run([fixture({ requires: ['observable_action', 'sse'] })]);
    assert.equal(result.outcome, 'skip');
    assert.match(result.reason, /sse/);
    assert.equal(fetch.calls.length, 0);
  });

  test('requires is satisfied by a capability, a role name or an extension name', async () => {
    const f = fixture({ requires: ['commands', 'fast_action', 'change-guard'] });
    const { result } = await run([f]);
    assert.equal(result.outcome, 'pass', result.reason);
  });

  test('a missing extension skips naming it', async () => {
    const f = fixture({ level: 'EXTENSION:forwarded-identity', requires: ['forwarded-identity'] });
    delete f.source;
    const { result } = await run([f]);
    assert.equal(result.outcome, 'skip');
    assert.match(result.reason, /forwarded-identity/);
  });

  test('a missing role name skips naming it', async () => {
    const { result } = await run([fixture({ requires: ['offline_action'] })]);
    assert.equal(result.outcome, 'skip');
    assert.match(result.reason, /offline_action/);
  });

  test('a live fixture skips unless the target sets live_vendor', async () => {
    const f = fixture({ tags: ['live'] });
    assert.equal((await run([f])).result.outcome, 'skip');
    assert.match((await run([f])).result.reason, /live/);
    assert.equal((await run([f], { target: target({ live_vendor: true }) })).result.outcome, 'pass');
  });
});

describe('runSuite: outcomes', () => {
  const teardown = [{ kind: 'request', method: 'POST', path: '/instances/x/command', body: { command: 'ABORT' }, tolerate: true }];

  test('a failing step fails, stops, and still runs teardown', async () => {
    const fetch = stubFetch((req) => (req.path === '/actions/act-1/invoke' ? { status: 500, body: {} } : INVOKE));
    const second = { kind: 'request', path: '/never', expect: { status: 200 } };
    const f = fixture({ steps: [...fixture().steps, second], teardown });
    const { result } = await run([f], { fetch });
    assert.equal(result.outcome, 'fail');
    assert.match(result.reason, /status 500/);
    assert.deepEqual(fetch.calls.map((c) => c.path), ['/actions/act-1/invoke', '/instances/x/command']);
    assert.equal(result.evidence.length, 2);
  });

  test('a setup failure is a fail with a setup: prefix, and teardown runs', async () => {
    const fetch = stubFetch((req) => (req.path === '/setup' ? { status: 500, body: {} } : INVOKE));
    const f = fixture({ setup: [{ kind: 'request', path: '/setup', expect: { status: 200 } }], teardown });
    const { result } = await run([f], { fetch });
    assert.equal(result.outcome, 'fail');
    assert.match(result.reason, /^setup:/);
    assert.deepEqual(fetch.calls.map((c) => c.path), ['/setup', '/instances/x/command']);
  });

  test('a tolerated setup failure skips a non-MUST fixture but fails a MUST one', async () => {
    const fetch = stubFetch((req) => (req.path === '/setup' ? { status: 500, body: {} } : INVOKE));
    const setup = [{ kind: 'request', path: '/setup', expect: { status: 200 }, tolerate: true }];
    const should = fixture({ level: 'SHOULD', setup });
    const must = fixture({ test_id: 'agt-002', setup });
    const { report } = await run([should, must], { fetch });
    assert.equal(report.results[0].outcome, 'skip');
    assert.match(report.results[0].reason, /^setup:/);
    assert.equal(report.results[1].outcome, 'fail');
    assert.match(report.results[1].reason, /^setup:/);
  });

  test('a setup step whose expectation gives a note is not a setup failure', async () => {
    const fetch = stubFetch((req) => (req.path === '/setup' ? { status: 500, body: {} } : INVOKE));
    const setup = [{ kind: 'request', path: '/setup', expect: { status: { one_of: [200], note_if: { range: [500, 599] } } } }];
    const { result } = await run([fixture({ setup })], { fetch });
    assert.equal(result.outcome, 'pass', result.reason);
  });

  test('a fetch error is a fail naming the request', async () => {
    const fetch = stubFetch(() => {
      throw new Error('ECONNREFUSED');
    });
    const { result } = await run([fixture()], { fetch });
    assert.equal(result.outcome, 'fail');
    assert.match(result.reason, /ECONNREFUSED/);
    assert.match(result.reason, /\/actions\/act-1\/invoke/);
  });

  test('a tolerated step error does not fail the fixture', async () => {
    const fetch = stubFetch((req) => {
      if (req.path === '/flaky') throw new Error('boom');
      return INVOKE;
    });
    const f = fixture({ steps: [{ kind: 'request', path: '/flaky', tolerate: true }, ...fixture().steps] });
    const { result } = await run([f], { fetch });
    assert.equal(result.outcome, 'pass', result.reason);
  });

  test('a teardown error without tolerate fails the fixture with a teardown: prefix', async () => {
    const fetch = stubFetch((req) => (req.path === '/down' ? { status: 500, body: {} } : INVOKE));
    const f = fixture({ teardown: [{ kind: 'request', path: '/down', expect: { status: 200 } }] });
    const { result } = await run([f], { fetch });
    assert.equal(result.outcome, 'fail');
    assert.match(result.reason, /^teardown:/);
  });

  test('note_if gives a note', async () => {
    const fetch = stubFetch(() => ({ status: 503, body: { error: { code: 'INSTANCE_ERROR' } } }));
    const f = fixture({
      level: 'IMPL-DEFINED',
      steps: [
        {
          kind: 'request',
          method: 'POST',
          path: '/x',
          body: {},
          expect: { status: { one_of: [409], note_if: { range: [500, 599] } }, json: [{ path: '$.error.code', present: true }] },
        },
      ],
    });
    const { result, report } = await run([f], { fetch });
    assert.equal(result.outcome, 'note');
    assert.match(result.reason, /503/);
    assert.deepEqual(report.totals, { pass: 0, fail: 0, note: 1, skip: 0 });
  });

  test('a SHOULD miss is a note', async () => {
    const fetch = stubFetch(() => ({ status: 500, body: {} }));
    const { result } = await run([fixture({ level: 'SHOULD' })], { fetch });
    assert.equal(result.outcome, 'note');
    assert.match(result.reason, /SHOULD/);
    assert.match(result.reason, /status 500/);
  });

  test('a known failure is a note with a known: prefix', async () => {
    const fetch = stubFetch(() => ({ status: 500, body: {} }));
    const t = target({ known_failures: { 'agt-001': 'door issue #12' } });
    const { result } = await run([fixture()], { fetch, target: t });
    assert.equal(result.outcome, 'note');
    assert.match(result.reason, /^known: door issue #12/);
    assert.match(result.reason, /status 500/);
  });

  test('a known failure that passes is still a pass', async () => {
    const t = target({ known_failures: { 'agt-001': 'door issue #12' } });
    const { result } = await run([fixture()], { target: t });
    assert.equal(result.outcome, 'pass');
  });

  test('a step kind the runner does not know fails naming it', async () => {
    const f = fixture({ steps: [{ kind: 'teleport' }] });
    const { result } = await run([f]);
    assert.equal(result.outcome, 'fail');
    assert.match(result.reason, /teleport/);
  });

  test('probe: true goes to probe_url', async () => {
    const f = fixture({ steps: [{ kind: 'request', path: '/audit/verify', probe: true, expect: { status: 202 } }] });
    const { fetch, result } = await run([f]);
    assert.equal(result.outcome, 'pass', result.reason);
    assert.equal(fetch.calls[0].url, 'http://stub.test/conformance/v1/audit/verify');
  });
});

describe('runSuite: redaction', () => {
  test('a token query value never reaches the report or the log', async () => {
    const lines = [];
    const f = fixture({ steps: [{ kind: 'request', path: '/instances/1/events?token=super-secret', expect: { status: 202 } }] });
    const { report } = await run([f], { log: (l) => lines.push(l) });
    assert.equal(report.results[0].evidence[0].path, '/instances/1/events?token=***');
    assert.doesNotMatch(JSON.stringify(report), /super-secret/);
    assert.doesNotMatch(lines.join('\n'), /super-secret/);
  });

  test('the api key never reaches the report', async () => {
    const fetch = stubFetch(() => {
      throw new Error('refused');
    });
    const f = fixture({ steps: [{ kind: 'request', path: '/x', headers: { Authorization: 'Bearer {{roles.environment_oid}}' } }] });
    const { report } = await run([f], { fetch });
    assert.doesNotMatch(JSON.stringify(report), /secret-key/);
  });
});

describe('exitCode', () => {
  const report = (results) => ({ results });

  test('0 when nothing fails', () => {
    assert.equal(exitCode(report([{ level: 'MUST', outcome: 'pass' }, { level: 'MUST', outcome: 'note' }])), 0);
  });

  test('0 when only a non-MUST fixture fails', () => {
    assert.equal(exitCode(report([{ level: 'IMPL-DEFINED', outcome: 'fail' }, { level: 'EXTENSION:x', outcome: 'fail' }])), 0);
  });

  test('1 when a MUST fixture fails', () => {
    assert.equal(exitCode(report([{ level: 'MUST', outcome: 'pass' }, { level: 'MUST', outcome: 'fail' }])), 1);
  });
});
