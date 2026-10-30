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

import { buildRequest, redact, redactUrl, redactValue, template } from '../src/http.mjs';

function target(extra = {}) {
  return {
    name: 'stub',
    base_url: 'http://stub.test/trajectory/v1/',
    probe_url: 'http://stub.test/conformance/v1',
    auth: { mode: 'required', header: 'X-API-Key', scheme: '' },
    capabilities: ['observable_action'],
    roles: { environment_oid: 'env-1', observable_action: 'act-1' },
    ...extra,
  };
}

const vars = { roles: target().roles, uniq: 'u1', iid: 'inst-7', count: 3 };

describe('template', () => {
  test('fills {{roles.X}}, {{uniq}} and captured names in strings', () => {
    assert.equal(template('/actions/{{roles.observable_action}}/x/{{uniq}}/{{iid}}', vars), '/actions/act-1/x/u1/inst-7');
  });

  test('a string that is exactly one placeholder keeps the value type', () => {
    assert.equal(template('{{count}}', vars), 3);
    assert.equal(template('n={{count}}', vars), 'n=3');
  });

  test('walks objects and arrays', () => {
    assert.deepEqual(template({ a: ['{{uniq}}-wf', { b: '{{iid}}' }], n: 1, t: true }, vars), {
      a: ['u1-wf', { b: 'inst-7' }],
      n: 1,
      t: true,
    });
  });

  test('an unknown placeholder throws naming it', () => {
    assert.throws(() => template('{{nope}}', vars), /\{\{nope\}\}/);
    assert.throws(() => template('{{roles.missing}}', vars), /roles\.missing/);
  });
});

describe('buildRequest', () => {
  test('joins base_url and the templated path, sends JSON and the auth header', () => {
    const step = {
      kind: 'request',
      method: 'POST',
      path: '/actions/{{roles.observable_action}}/invoke',
      body: { environment_oid: '{{roles.environment_oid}}', wf: '{{uniq}}-wf' },
    };
    const { url, init } = buildRequest(target(), step, vars, 'secret-key');
    assert.equal(url, 'http://stub.test/trajectory/v1/actions/act-1/invoke');
    assert.equal(init.method, 'POST');
    const h = new Headers(init.headers);
    assert.equal(h.get('x-api-key'), 'secret-key');
    assert.equal(h.get('content-type'), 'application/json');
    assert.equal(h.get('accept'), 'application/json');
    assert.deepEqual(JSON.parse(init.body), { environment_oid: 'env-1', wf: 'u1-wf' });
  });

  test('GET is the default and has no body or content-type', () => {
    const { init } = buildRequest(target(), { kind: 'request', path: '/instances/{{iid}}' }, vars, 'k');
    assert.equal(init.method, 'GET');
    assert.equal(init.body, undefined);
    assert.equal(new Headers(init.headers).get('content-type'), null);
  });

  test('a scheme is prefixed to the key', () => {
    const t = target({ auth: { mode: 'required', header: 'Authorization', scheme: 'Bearer' } });
    const { init } = buildRequest(t, { kind: 'request', path: '/x' }, vars, 'k');
    assert.equal(new Headers(init.headers).get('authorization'), 'Bearer k');
  });

  test('auth mode none sends no key even when one is set', () => {
    const t = target({ auth: { mode: 'none' } });
    const { init } = buildRequest(t, { kind: 'request', path: '/x' }, vars, 'k');
    assert.equal(new Headers(init.headers).get('x-api-key'), null);
  });

  test('a step with auth: false omits the key', () => {
    const { init } = buildRequest(target(), { kind: 'request', path: '/x', auth: false }, vars, 'k');
    assert.equal(new Headers(init.headers).get('x-api-key'), null);
  });

  test('step headers are templated and override defaults', () => {
    const step = { kind: 'request', path: '/x', headers: { Origin: '{{iid}}', Accept: 'text/event-stream' } };
    const { init } = buildRequest(target(), step, vars, 'k');
    const h = new Headers(init.headers);
    assert.equal(h.get('origin'), 'inst-7');
    assert.equal(h.get('accept'), 'text/event-stream');
  });

  test('probe: true uses probe_url', () => {
    const { url } = buildRequest(target(), { kind: 'request', path: '/audit/verify', probe: true }, vars, 'k');
    assert.equal(url, 'http://stub.test/conformance/v1/audit/verify');
  });

  test('probe: true without a probe_url throws', () => {
    const t = target();
    delete t.probe_url;
    assert.throws(() => buildRequest(t, { kind: 'request', path: '/x', probe: true }, vars, 'k'), /probe_url/);
  });
});

describe('redact', () => {
  test('masks X-API-Key and Authorization whatever their case', () => {
    const out = redact({ 'x-api-key': 'secret', Authorization: 'Bearer secret', Accept: 'application/json' });
    assert.deepEqual(out, { 'x-api-key': '***', Authorization: '***', Accept: 'application/json' });
  });

  test('accepts a Headers instance', () => {
    const out = redact(new Headers({ 'X-API-Key': 'secret', Vary: 'Origin' }));
    assert.deepEqual(out, { 'x-api-key': '***', vary: 'Origin' });
  });

  test('masks X-Trajectory-User (forwarded-identity user token) whatever its case', () => {
    const out = redact({ 'X-Trajectory-User': 'Bearer user-secret', 'x-trajectory-user': 'Bearer user-secret' });
    assert.deepEqual(out, { 'X-Trajectory-User': '***', 'x-trajectory-user': '***' });
    assert.equal(redactValue('x-trajectory-user', 'Bearer user-secret'), '***');
    assert.equal(redactValue('X-TRAJECTORY-USER', 'Bearer user-secret'), '***');
  });

  test('masks token= inside any header value', () => {
    const out = redact({ Location: 'http://stub.test/stream?token=abc123&x=1' });
    assert.equal(out.Location, 'http://stub.test/stream?token=***&x=1');
  });

  test('redactValue masks a secret header whatever its case, and token= in any other', () => {
    assert.equal(redactValue('authorization', 'Bearer s3cret'), '***');
    assert.equal(redactValue('X-Api-Key', 's3cret'), '***');
    assert.equal(redactValue('Location', '/s?token=abc'), '/s?token=***');
    assert.equal(redactValue('Vary', 'Origin'), 'Origin');
  });

  test('redactUrl masks a token query value', () => {
    assert.equal(redactUrl('/instances/1/events?token=abc'), '/instances/1/events?token=***');
    assert.equal(redactUrl('/instances/1/events?a=1&token=abc&b=2'), '/instances/1/events?a=1&token=***&b=2');
    assert.equal(redactUrl('/instances/1'), '/instances/1');
  });
});
