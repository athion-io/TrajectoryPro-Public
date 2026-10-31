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

import { canonicalize, sha256Digest } from '../src/jcs.mjs';
import { eventHash, verifyChain } from '../src/audit.mjs';

/** Builds a hand-made three-event chain: genesis, step.invoked, step.done. */
function chain() {
  const base = (i, action, payload) => ({
    id: `evt-${i}`,
    ts: `2026-10-29T12:00:0${i}.000Z`,
    actor: 'runner',
    action,
    scope_kind: 'run',
    scope_id: 'run-1',
    resource_type: 'step',
    resource_id: 'step-1',
    rev: i,
    reason: '',
    payload,
    subject_hash: '',
    recipe: 'jcs-sha256-v2',
    prev_hash: '',
    hash: '',
    signature: '',
  });
  const e0 = base(0, 'run.started', { workflow: 'wf-1' });
  e0.hash = eventHash(e0);
  const e1 = base(1, 'step.invoked', { action_oid: 'act-1' });
  e1.prev_hash = e0.hash;
  e1.hash = eventHash(e1);
  const e2 = base(2, 'step.done', { state: 'COMPLETE' });
  e2.prev_hash = e1.hash;
  e2.hash = eventHash(e2);
  return [e0, e1, e2];
}

const clone = (v) => JSON.parse(JSON.stringify(v));

describe('eventHash', () => {
  test('digests the canonical event without hash and signature', () => {
    const [e0] = chain();
    const { hash, signature, ...rest } = e0;
    assert.equal(e0.hash, sha256Digest(canonicalize(rest)));
    assert.match(e0.hash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(eventHash({ ...e0, hash: 'x', signature: 'y' }), e0.hash);
  });

  test('unknown fields change the hash (C-AUD-1)', () => {
    const [e0] = chain();
    assert.notEqual(eventHash({ ...e0, extra: 1 }), e0.hash);
  });

  test('any payload change changes the hash', () => {
    const [e0] = chain();
    assert.notEqual(eventHash({ ...e0, payload: { workflow: 'wf-2' } }), e0.hash);
  });

  test('rejects non-object events', () => {
    assert.throws(() => eventHash(null), TypeError);
    assert.throws(() => eventHash([1]), TypeError);
    assert.throws(() => eventHash('evt'), TypeError);
  });
});

describe('verifyChain', () => {
  test('a clean chain reports no issues', () => {
    assert.deepEqual(verifyChain(chain()), []);
  });

  test('a chain with bare-hex hashes and prefixed links is still clean', () => {
    const events = chain();
    events[1].hash = events[1].hash.slice('sha256:'.length);
    events[2].prev_hash = events[1].hash.toUpperCase();
    events[2].hash = eventHash(events[2]).toUpperCase(); // prev_hash is hashed content
    assert.deepEqual(verifyChain(events), []);
  });

  test('an empty trail is clean', () => {
    assert.deepEqual(verifyChain([]), []);
  });

  test('altered: payload edited after hashing', () => {
    const events = chain();
    events[1].payload.action_oid = 'act-9';
    assert.deepEqual(verifyChain(events), [{ index: 1, id: 'evt-1', issue: 'altered' }]);
  });

  test('altered: a field removed or added after hashing', () => {
    const removed = chain();
    delete removed[2].reason;
    assert.deepEqual(verifyChain(removed), [{ index: 2, id: 'evt-2', issue: 'altered' }]);
    const added = chain();
    added[0].note = 'late';
    assert.deepEqual(verifyChain(added), [{ index: 0, id: 'evt-0', issue: 'altered' }]);
  });

  test('altered: signature changes do not count', () => {
    const events = chain();
    events[1].signature = 'sig-1';
    assert.deepEqual(verifyChain(events), []);
  });

  test('broken_link: prev_hash does not match the previous hash', () => {
    const events = chain();
    events[2].prev_hash = events[0].hash;
    events[2].hash = eventHash(events[2]); // re-hashed so the only issue is the link
    assert.deepEqual(verifyChain(events), [{ index: 2, id: 'evt-2', issue: 'broken_link' }]);
  });

  test('broken_link: an event missing from the middle', () => {
    const [e0, , e2] = chain();
    assert.deepEqual(verifyChain([e0, e2]), [{ index: 1, id: 'evt-2', issue: 'broken_link' }]);
  });

  test('broken_link: reordered events', () => {
    const [e0, e1, e2] = chain();
    assert.deepEqual(verifyChain([e0, e2, e1]), [
      { index: 1, id: 'evt-2', issue: 'broken_link' },
      { index: 2, id: 'evt-1', issue: 'broken_link' },
    ]);
  });

  test('bad_genesis: first event has a non-empty prev_hash', () => {
    const events = chain();
    events[0].prev_hash = sha256Digest('something');
    events[0].hash = eventHash(events[0]);
    events[1].prev_hash = events[0].hash;
    events[1].hash = eventHash(events[1]);
    events[2].prev_hash = events[1].hash;
    events[2].hash = eventHash(events[2]);
    assert.deepEqual(verifyChain(events), [{ index: 0, id: 'evt-0', issue: 'bad_genesis' }]);
  });

  test('bad_genesis: first event has no prev_hash field at all', () => {
    const events = chain();
    delete events[0].prev_hash;
    events[0].hash = eventHash(events[0]);
    events[1].prev_hash = events[0].hash;
    events[1].hash = eventHash(events[1]);
    events[2].prev_hash = events[1].hash;
    events[2].hash = eventHash(events[2]);
    assert.deepEqual(verifyChain(events), [{ index: 0, id: 'evt-0', issue: 'bad_genesis' }]);
  });

  test('duplicate_id: the later occurrence is reported', () => {
    const events = chain();
    events[2].id = 'evt-0';
    events[2].hash = eventHash(events[2]);
    assert.deepEqual(verifyChain(events), [{ index: 2, id: 'evt-0', issue: 'duplicate_id' }]);
  });

  test('duplicate_id: a tampered id is also altered', () => {
    const events = chain();
    events[2].id = 'evt-1';
    assert.deepEqual(verifyChain(events), [
      { index: 2, id: 'evt-1', issue: 'altered' },
      { index: 2, id: 'evt-1', issue: 'duplicate_id' },
    ]);
  });

  test('secret_in_payload: top-level keys matching the secret pattern', () => {
    for (const key of ['password', 'Secret', 'TOKEN', 'api_key', 'api-key', 'apiKey', 'client_secret', 'access_token']) {
      const events = chain();
      events[1].payload[key] = 'hunter2-value';
      events[1].hash = eventHash(events[1]);
      events[2].prev_hash = events[1].hash;
      events[2].hash = eventHash(events[2]);
      assert.deepEqual(verifyChain(events), [{ index: 1, id: 'evt-1', issue: 'secret_in_payload' }], key);
    }
  });

  test('secret_in_payload: nested objects and arrays are scanned', () => {
    const events = chain();
    events[2].payload = { outputs: [{ name: 'x' }, { credentials: { api_key: 'k-123' } }] };
    events[2].hash = eventHash(events[2]);
    assert.deepEqual(verifyChain(events), [{ index: 2, id: 'evt-2', issue: 'secret_in_payload' }]);
  });

  test('secret_in_payload: empty or non-string values do not count, one issue per event', () => {
    const events = chain();
    events[1].payload = { token: '', password: null, secret: 0, api_key: false, token_count: 3, has_secret: true };
    events[1].hash = eventHash(events[1]);
    events[2].prev_hash = events[1].hash;
    events[2].hash = eventHash(events[2]);
    assert.deepEqual(verifyChain(events), []);

    const two = chain();
    two[1].payload = { token: 'a', password: 'b' };
    two[1].hash = eventHash(two[1]);
    two[2].prev_hash = two[1].hash;
    two[2].hash = eventHash(two[2]);
    assert.deepEqual(verifyChain(two), [{ index: 1, id: 'evt-1', issue: 'secret_in_payload' }]);
  });

  test('secret_in_payload: the issue never carries the secret value', () => {
    const events = chain();
    events[1].payload.password = 'very-secret-value';
    events[1].hash = eventHash(events[1]);
    events[2].prev_hash = events[1].hash;
    events[2].hash = eventHash(events[2]);
    const text = JSON.stringify(verifyChain(events));
    assert.doesNotMatch(text, /very-secret-value/);
  });

  test('secret_in_payload: secret-looking keys outside payload are ignored', () => {
    const events = chain();
    events[1].token = 'not-the-payload';
    events[1].hash = eventHash(events[1]);
    events[2].prev_hash = events[1].hash;
    events[2].hash = eventHash(events[2]);
    assert.deepEqual(verifyChain(events), []);
  });

  test('a missing payload is not a secret issue', () => {
    const events = chain();
    delete events[1].payload;
    events[1].hash = eventHash(events[1]);
    events[2].prev_hash = events[1].hash;
    events[2].hash = eventHash(events[2]);
    assert.deepEqual(verifyChain(events), []);
  });

  test('issues come back in index order with several events wrong', () => {
    const events = chain();
    events[0].payload.workflow = 'tampered';
    events[2].payload.password = 'p';
    assert.deepEqual(verifyChain(events), [
      { index: 0, id: 'evt-0', issue: 'altered' },
      { index: 2, id: 'evt-2', issue: 'altered' },
      { index: 2, id: 'evt-2', issue: 'secret_in_payload' },
    ]);
  });

  test('id is reported as null when missing', () => {
    const events = chain();
    delete events[1].id;
    assert.deepEqual(verifyChain(events), [{ index: 1, id: null, issue: 'altered' }]);
  });

  test('does not mutate the events', () => {
    const events = chain();
    const before = clone(events);
    verifyChain(events);
    assert.deepEqual(events, before);
  });

  test('rejects non-array input and non-object events', () => {
    assert.throws(() => verifyChain(null), TypeError);
    assert.throws(() => verifyChain({ events: [] }), TypeError);
    assert.throws(() => verifyChain([chain()[0], 'evt']), TypeError);
  });
});
