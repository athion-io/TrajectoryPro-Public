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

import { check, jsonPath } from '../src/assert.mjs';

const body = {
  data: { instance_id: 'inst-1', state: 'EXECUTING', count: 3, tags: ['a', 'b'] },
  items: [{ id: 'x' }, { id: 'y' }],
  nothing: null,
};

/** A response with a JSON body and a few headers. */
function response(status = 200, json = body, headers = {}) {
  return { status, headers: new Headers({ 'content-type': 'application/json', ...headers }), json };
}

describe('jsonPath', () => {
  test('$ is the whole document', () => {
    assert.deepEqual(jsonPath(body, '$'), [body]);
  });

  test('.key walks objects', () => {
    assert.deepEqual(jsonPath(body, '$.data.instance_id'), ['inst-1']);
  });

  test('[n] indexes arrays', () => {
    assert.deepEqual(jsonPath(body, '$.items[1].id'), ['y']);
    assert.deepEqual(jsonPath(body, '$.data.tags[0]'), ['a']);
  });

  test('[*] fans out over arrays', () => {
    assert.deepEqual(jsonPath(body, '$.items[*].id'), ['x', 'y']);
  });

  test('[-n] indexes from the end of an array', () => {
    assert.deepEqual(jsonPath(body, '$.items[-1].id'), ['y']);
    assert.deepEqual(jsonPath(body, '$.items[-2].id'), ['x']);
    assert.deepEqual(jsonPath(body, '$.items[-3]'), []);
    assert.deepEqual(jsonPath(body, '$.data.instance_id[-1]'), []);
  });

  test('a missing key gives no matches', () => {
    assert.deepEqual(jsonPath(body, '$.data.missing'), []);
    assert.deepEqual(jsonPath(body, '$.items[5].id'), []);
    assert.deepEqual(jsonPath(body, '$.data.instance_id.deeper'), []);
  });

  test('[*] on something that is not an array gives no matches', () => {
    assert.deepEqual(jsonPath(body, '$.data.instance_id[*]'), []);
  });

  test('a null value is a match', () => {
    assert.deepEqual(jsonPath(body, '$.nothing'), [null]);
  });

  test('a path outside the subset throws', () => {
    assert.throws(() => jsonPath(body, 'data.instance_id'), /path/);
    assert.throws(() => jsonPath(body, '$..instance_id'), /path/);
    assert.throws(() => jsonPath(body, "$['data']"), /path/);
  });
});

describe('check: status', () => {
  test('an integer must match exactly', () => {
    assert.equal(check({ status: 200 }, response(200)).outcome, 'pass');
    const r = check({ status: 202 }, response(200));
    assert.equal(r.outcome, 'fail');
    assert.match(r.reason, /status 200/);
    assert.match(r.reason, /202/);
  });

  test('one_of passes on any listed status', () => {
    assert.equal(check({ status: { one_of: [200, 202] } }, response(202)).outcome, 'pass');
  });

  test('note_if one_of gives a note, not a fail', () => {
    const r = check({ status: { one_of: [409], note_if: { one_of: [500] } } }, response(500));
    assert.equal(r.outcome, 'note');
    assert.match(r.reason, /500/);
  });

  test('note_if range is inclusive', () => {
    const e = { status: { one_of: [409], note_if: { range: [500, 599] } } };
    assert.equal(check(e, response(500)).outcome, 'note');
    assert.equal(check(e, response(599)).outcome, 'note');
    assert.equal(check(e, response(409)).outcome, 'pass');
    assert.equal(check(e, response(600)).outcome, 'fail');
    assert.equal(check(e, response(499)).outcome, 'fail');
  });

  test('a status outside one_of and note_if fails naming both', () => {
    const r = check({ status: { one_of: [409], note_if: { range: [500, 599] } } }, response(200));
    assert.equal(r.outcome, 'fail');
    assert.match(r.reason, /status 200/);
    assert.match(r.reason, /409/);
  });
});

describe('check: json', () => {
  const ok = (item) => check({ json: [item] }, response());
  const bad = (item) => {
    const r = check({ json: [item] }, response());
    assert.equal(r.outcome, 'fail', `expected fail for ${JSON.stringify(item)}`);
    assert.match(r.reason, new RegExp(item.path.replace(/[$[\]*.]/g, '\\$&')));
    return r;
  };

  test('present', () => {
    assert.equal(ok({ path: '$.data.instance_id', present: true }).outcome, 'pass');
    assert.equal(ok({ path: '$.nothing', present: true }).outcome, 'pass');
    bad({ path: '$.data.missing', present: true });
    assert.equal(ok({ path: '$.data.missing', present: false }).outcome, 'pass');
  });

  test('absent', () => {
    assert.equal(ok({ path: '$.data.missing', absent: true }).outcome, 'pass');
    bad({ path: '$.data.instance_id', absent: true });
  });

  test('equals compares deeply', () => {
    assert.equal(ok({ path: '$.data.state', equals: 'EXECUTING' }).outcome, 'pass');
    assert.equal(ok({ path: '$.data.tags', equals: ['a', 'b'] }).outcome, 'pass');
    assert.equal(ok({ path: '$.nothing', equals: null }).outcome, 'pass');
    const r = bad({ path: '$.data.state', equals: 'HELD' });
    assert.match(r.reason, /EXECUTING/);
    assert.match(r.reason, /HELD/);
  });

  test('where keeps only matches whose sub-path equals the value; select then picks a sub-path', () => {
    const caps = { data: { envs: [{ actions: [{ oid: 'a', cmds: ['PAUSE', 'ABORT'] }, { oid: 'b', cmds: ['ABORT'] }] }] } };
    const r = (item) => check({ json: [item] }, response(200, caps));
    const base = { path: '$.data.envs[*].actions[*]', where: { path: '$.oid', equals: 'b' } };
    assert.equal(r({ ...base, select: '$.cmds', equals: ['ABORT'] }).outcome, 'pass');
    assert.equal(r({ ...base, type: 'object' }).outcome, 'pass');
    const wrong = r({ ...base, select: '$.cmds', equals: ['PAUSE'] });
    assert.equal(wrong.outcome, 'fail');
    assert.match(wrong.reason, /\["ABORT"\]/);
    const none = r({ path: '$.data.envs[*].actions[*]', where: { path: '$.oid', equals: 'zzz' }, select: '$.cmds', type: 'array' });
    assert.equal(none.outcome, 'fail');
    assert.match(none.reason, /nothing at path/);
    assert.match(none.reason, /oid/);
    const noSub = r({ ...base, select: '$.missing', type: 'array' });
    assert.equal(noSub.outcome, 'fail');
    assert.match(noSub.reason, /nothing at path/);
  });

  test('equals with no value at the path fails', () => {
    bad({ path: '$.data.missing', equals: 'x' });
  });

  test('not_equals passes on a different value and fails on the same one', () => {
    assert.equal(ok({ path: '$.data.state', not_equals: 'HELD' }).outcome, 'pass');
    assert.equal(ok({ path: '$.data.tags', not_equals: ['a'] }).outcome, 'pass');
    const r = bad({ path: '$.data.state', not_equals: 'EXECUTING' });
    assert.match(r.reason, /EXECUTING/);
    assert.match(r.reason, /different/);
    bad({ path: '$.data.missing', not_equals: 'x' });
  });

  test('type', () => {
    assert.equal(ok({ path: '$.data.state', type: 'string' }).outcome, 'pass');
    assert.equal(ok({ path: '$.data.count', type: 'number' }).outcome, 'pass');
    assert.equal(ok({ path: '$.data.count', type: 'integer' }).outcome, 'pass');
    assert.equal(ok({ path: '$.data.tags', type: 'array' }).outcome, 'pass');
    assert.equal(ok({ path: '$.data', type: 'object' }).outcome, 'pass');
    assert.equal(ok({ path: '$.nothing', type: 'null' }).outcome, 'pass');
    bad({ path: '$.data.tags', type: 'object' });
    bad({ path: '$.data.state', type: 'number' });
    bad({ path: '$.data.missing', type: 'string' });
  });

  test('in', () => {
    assert.equal(ok({ path: '$.data.state', in: ['HELD', 'EXECUTING'] }).outcome, 'pass');
    bad({ path: '$.data.state', in: ['HELD'] });
  });

  test('matches is a regular expression over a string', () => {
    assert.equal(ok({ path: '$.data.instance_id', matches: '^inst-\\d+$' }).outcome, 'pass');
    bad({ path: '$.data.instance_id', matches: '^x' });
    bad({ path: '$.data.count', matches: '3' });
  });

  test('length_max applies to arrays and strings', () => {
    assert.equal(ok({ path: '$.data.tags', length_max: 2 }).outcome, 'pass');
    assert.equal(ok({ path: '$.data.state', length_max: 9 }).outcome, 'pass');
    bad({ path: '$.data.tags', length_max: 1 });
    bad({ path: '$.data.count', length_max: 1 });
  });

  test('every match must satisfy the operator', () => {
    assert.equal(ok({ path: '$.items[*].id', type: 'string' }).outcome, 'pass');
    bad({ path: '$.items[*].id', equals: 'x' });
  });

  test('a body that is not JSON fails every json check', () => {
    const r = check({ json: [{ path: '$.data', present: true }] }, { status: 200, headers: new Headers(), json: undefined });
    assert.equal(r.outcome, 'fail');
    assert.match(r.reason, /JSON/);
  });

  test('an item with no operator is an error, not a silent pass', () => {
    assert.throws(() => ok({ path: '$.data' }), /operator/);
  });
});

describe('check: headers', () => {
  const res = () => response(200, body, { 'Access-Control-Allow-Methods': 'GET, POST', Vary: 'Origin' });

  test('present, case-insensitively', () => {
    assert.equal(check({ headers: { vary: { present: true } } }, res()).outcome, 'pass');
    const r = check({ headers: { 'X-Missing': { present: true } } }, res());
    assert.equal(r.outcome, 'fail');
    assert.match(r.reason, /X-Missing/);
  });

  test('present: false means absent', () => {
    assert.equal(check({ headers: { 'X-Missing': { present: false } } }, res()).outcome, 'pass');
    assert.equal(check({ headers: { Vary: { present: false } } }, res()).outcome, 'fail');
  });

  test('equals', () => {
    assert.equal(check({ headers: { Vary: { equals: 'Origin' } } }, res()).outcome, 'pass');
    const r = check({ headers: { Vary: { equals: 'Accept' } } }, res());
    assert.equal(r.outcome, 'fail');
    assert.match(r.reason, /Vary/);
  });

  test('contains_token splits on commas and ignores case', () => {
    const h = 'Access-Control-Allow-Methods';
    assert.equal(check({ headers: { [h]: { contains_token: 'post' } } }, res()).outcome, 'pass');
    assert.equal(check({ headers: { [h]: { contains_token: 'DELETE' } } }, res()).outcome, 'fail');
    assert.equal(check({ headers: { 'X-Missing': { contains_token: 'x' } } }, res()).outcome, 'fail');
  });

  test('plain-object headers work too', () => {
    const r = check({ headers: { vary: { equals: 'Origin' } } }, { status: 200, headers: { Vary: 'Origin' }, json: {} });
    assert.equal(r.outcome, 'pass');
  });

  test('a mismatch reason masks a token= query value in the header', () => {
    const r = check({ headers: { Location: { equals: '/stream' } } }, response(200, body, { Location: '/stream?token=x' }));
    assert.equal(r.outcome, 'fail');
    assert.match(r.reason, /token=\*\*\*/);
    assert.doesNotMatch(r.reason, /token=x/);
    const c = check({ headers: { Link: { contains_token: 'next' } } }, response(200, body, { Link: '</s?token=x>; rel=prev' }));
    assert.match(c.reason, /token=\*\*\*/);
    assert.doesNotMatch(c.reason, /token=x/);
  });

  test('a mismatch reason masks the value of a secret header', () => {
    for (const name of ['Authorization', 'X-API-Key']) {
      const r = check({ headers: { [name]: { equals: 'expected' } } }, response(200, body, { [name]: 'Bearer s3cret' }));
      assert.equal(r.outcome, 'fail');
      assert.match(r.reason, /\*\*\*/);
      assert.doesNotMatch(r.reason, /s3cret/);
      const c = check({ headers: { [name]: { contains_token: 'x' } } }, response(200, body, { [name]: 's3cret' }));
      assert.doesNotMatch(c.reason, /s3cret/);
    }
  });
});

describe('check: combining', () => {
  test('a json mismatch reason masks a token= query value in the body', () => {
    const json = { data: { stream_url: 'http://stub.test/s?token=x&a=1' } };
    const r = check({ json: [{ path: '$.data.stream_url', equals: '/other' }] }, response(200, json));
    assert.equal(r.outcome, 'fail');
    assert.match(r.reason, /token=\*\*\*/);
    assert.doesNotMatch(r.reason, /token=x/);
  });

  test('an empty expectation passes', () => {
    assert.deepEqual(check({}, response()), { outcome: 'pass', reason: '' });
    assert.equal(check(undefined, response()).outcome, 'pass');
  });

  test('a fail beats a note', () => {
    const r = check(
      { status: { one_of: [409], note_if: { range: [500, 599] } }, json: [{ path: '$.error.code', present: true }] },
      response(500),
    );
    assert.equal(r.outcome, 'fail');
    assert.match(r.reason, /error\.code/);
  });

  test('a note with everything else passing is a note', () => {
    const r = check(
      { status: { one_of: [409], note_if: { range: [500, 599] } }, json: [{ path: '$.data', present: true }] },
      response(500),
    );
    assert.equal(r.outcome, 'note');
  });

  test('every failing check is listed in the reason', () => {
    const r = check({ status: 202, json: [{ path: '$.data.missing', present: true }] }, response(200));
    assert.match(r.reason, /status 200/);
    assert.match(r.reason, /missing/);
  });
});
