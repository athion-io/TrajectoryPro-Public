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

// Generator for the committed audit trails in audit-trail/fixtures/trails/.
// The files are produced here with the runner's own jcs.mjs / audit.mjs, so
// audit-suite.test.mjs can regenerate them and prove the committed bytes
// have not drifted. Every tampered trail starts from the same good chain and
// applies exactly one tamper; `issues` is what verifyChain must report.
// Run `node test/audit-trails.mjs` from contracts/runner to rewrite them.

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalize, sha256Digest } from '../src/jcs.mjs';
import { eventHash } from '../src/audit.mjs';

export const TRAILS_DIR = fileURLToPath(new URL('../../audit-trail/fixtures/trails/', import.meta.url));

/** Obviously fake; the only thing it must do is trip SECRET_KEY_RE under a secret-looking key. */
export const FAKE_SECRET = 'not-a-real-secret-fixture-value';

const T0 = Date.UTC(2026, 9, 29, 12, 0, 0, 0);
const SCOPE = 'wf-4f1c';

/** The five-event content of the good trail, in C-AUD-1 field order, before chaining. */
function contents() {
  const base = (i, action, resource_type, resource_id, rev, reason, payload) => ({
    id: `ev-${String(i + 1).padStart(3, '0')}`,
    ts: new Date(T0 + i * 1000).toISOString(),
    actor: { kind: i === 0 || i === 4 ? 'user' : 'runtime', id: i === 0 || i === 4 ? 'u-operator-1' : 'rt-1' },
    action,
    scope_kind: 'workflow_instance',
    scope_id: SCOPE,
    resource_type,
    resource_id,
    rev,
    reason,
    payload,
    subject_hash: sha256Digest(canonicalize(payload)),
    recipe: 'jcs-sha256',
    signature: '',
  });
  return [
    base(0, 'run.started', 'workflow_instance', SCOPE, 1, 'operator start', { workflow_oid: 'wf-pack-7', environment_oid: 'env-c1' }),
    base(1, 'step.invoked', 'step_instance', 'si-1', 1, 'scheduler', { action_oid: 'act-hold', instance_id: 'inst-1', inputs: [{ name: 'target_pressure', value: 2.5 }] }),
    base(2, 'step.state', 'step_instance', 'si-1', 2, 'container event', { instance_id: 'inst-1', state: 'EXECUTING', previous_state: 'STARTING', note: 'as reported by the container' }),
    base(3, 'step.done', 'step_instance', 'si-1', 3, 'container event', { instance_id: 'inst-1', state: 'COMPLETED', outputs: [{ name: 'final_pressure', value: 2.49 }] }),
    base(4, 'run.completed', 'workflow_instance', SCOPE, 2, 'all steps done', { steps: 1, outcome: 'COMPLETED' }),
  ];
}

/** Chains and hashes `items` in order (C-AUD-3/4): prev_hash of the genesis event is "". */
export function chain(items) {
  const out = [];
  let prev = '';
  for (const item of items) {
    const { signature, ...rest } = item;
    const event = { ...rest, prev_hash: prev, signature };
    event.hash = eventHash(event);
    prev = event.hash;
    out.push(event);
  }
  return out;
}

/** JSONL text for a trail: one event per line, trailing newline. */
export function toJsonl(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + '\n';
}

/**
 * Every committed trail: name -> {events, issues}. `issues` is the exact
 * verifyChain output for the trail (index/id/issue), which the fixtures and
 * CONTRACT.md pin.
 */
export function buildTrails() {
  const good = () => chain(contents());

  // Content changed after hashing: the stored hash no longer matches (C-AUD-3).
  // The next event's prev_hash still equals the stored hash, so the link holds.
  const altered = good();
  altered[2].payload = { ...altered[2].payload, note: 'edited after the hash was taken' };

  // The last event claims a different predecessor and is re-hashed over that
  // claim, so the hash is consistent but the chain is not (C-AUD-4).
  const linkBroken = good();
  linkBroken[4].prev_hash = sha256Digest('not the previous event');
  linkBroken[4].hash = eventHash(linkBroken[4]);

  // Two consistent events swapped: every link from the swap onwards is wrong (C-AUD-4).
  const reordered = good();
  [reordered[1], reordered[2]] = [reordered[2], reordered[1]];

  // A repeated id, chained consistently so only uniqueness is violated (C-AUD-5).
  const dupContents = contents();
  dupContents[4].id = dupContents[1].id;
  const duplicateId = chain(dupContents);

  // A secret-looking key with a non-empty value, chained consistently (C-AUD-6).
  const secretContents = contents();
  secretContents[3].payload = { ...secretContents[3].payload, api_key: FAKE_SECRET };
  const secret = chain(secretContents);

  return {
    good: { events: good(), issues: [] },
    'payload-altered': { events: altered, issues: [{ index: 2, id: 'ev-003', issue: 'altered' }] },
    'link-broken': { events: linkBroken, issues: [{ index: 4, id: 'ev-005', issue: 'broken_link' }] },
    reordered: {
      events: reordered,
      issues: [
        { index: 1, id: 'ev-003', issue: 'broken_link' },
        { index: 2, id: 'ev-002', issue: 'broken_link' },
        { index: 3, id: 'ev-004', issue: 'broken_link' },
      ],
    },
    'duplicate-id': { events: duplicateId, issues: [{ index: 4, id: 'ev-002', issue: 'duplicate_id' }] },
    secret: { events: secret, issues: [{ index: 3, id: 'ev-004', issue: 'secret_in_payload' }] },
  };
}

export function writeTrails(dir = TRAILS_DIR) {
  mkdirSync(dir, { recursive: true });
  for (const [name, { events }] of Object.entries(buildTrails())) {
    writeFileSync(join(dir, `${name}.jsonl`), toJsonl(events));
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeTrails();
  process.stdout.write(`trails written to ${TRAILS_DIR}\n`);
}
