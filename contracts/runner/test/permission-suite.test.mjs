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

// The permission suite against the toy's /conformance/v1/permission/decide
// probe. No sockets, no real timers: the toy is in process.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures, loadTarget } from '../src/load.mjs';
import { runSuite, exitCode } from '../src/run.mjs';
import { makeToy, DEFECTS, decidePermission, PERMISSION_REASONS } from './toy-container.mjs';

const RUNNER = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = path.resolve(RUNNER, '..');
const TARGET = path.join(CONTRACTS, 'targets', 'toy.target.json');
const API_KEY = 'toy-api-key-fixture';

const EXPECTED_IDS = [
  'prm-001', 'prm-002', 'prm-003', 'prm-004', 'prm-005', 'prm-006', 'prm-007', 'prm-008',
  'prm-009', 'prm-010', 'prm-011', 'prm-012', 'prm-013', 'prm-014', 'prm-015', 'prm-016',
];
const SELF_APPROVAL_ID = 'prm-014';
const REASONS = [
  'OK', 'NO_ROLE', 'WRONG_WORK_CENTER', 'GRANT_SCOPE_OWN', 'NOT_OWNER',
  'AGENT_MODE_EXCEEDED', 'QUORUM_NOT_MET', 'SELF_APPROVAL', 'SAME_PERSON_TWICE',
];

function drivingClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    advance: (ms) => { now += ms; },
  };
}

function describeFails(report) {
  return report.results.filter((r) => r.outcome === 'fail').map((r) => r.test_id).sort();
}

async function runToy({ defects = [], target } = {}) {
  const toy = makeToy({ apiKey: API_KEY, defects });
  const fixtures = await loadFixtures(CONTRACTS, { categories: ['permission'] });
  const report = await runSuite({
    target: target ?? await loadTarget(TARGET),
    fixtures,
    apiKey: API_KEY,
    fetch: toy.fetch,
    clock: drivingClock(),
    contractsRoot: CONTRACTS,
  });
  return { report, toy };
}

/** The reason each fixture's single step expects, read from its expect block. */
function expectedReason(fixture) {
  const item = fixture.steps[0].expect.json.find((a) => a.path === '$.data.reason');
  return item?.equals;
}

describe('permission fixtures', () => {
  let fixtures;
  before(async () => {
    fixtures = await loadFixtures(CONTRACTS, { categories: ['permission'] });
  });

  test('the brief\'s fixture set is present', () => {
    assert.deepEqual(fixtures.map((f) => f.test_id).sort(), EXPECTED_IDS);
  });

  test('every fixture is MUST, cites a C-PRM source, requires permission_probe and probes', () => {
    for (const f of fixtures) {
      assert.equal(f.level, 'MUST', f.test_id);
      assert.match(f.source, /^C-PRM-[1-5]$/, f.test_id);
      assert.ok(f.requires.includes('permission_probe'), `${f.test_id} requires permission_probe`);
      assert.equal(f.steps.length, 1, `${f.test_id} is one decide call`);
      assert.equal(f.steps[0].probe, true, `${f.test_id} goes to probe_url`);
      assert.equal(f.steps[0].path, '/permission/decide', f.test_id);
    }
  });

  test('every reason code in the closed set is expected by at least one fixture', () => {
    const seen = new Set(fixtures.map(expectedReason).filter(Boolean));
    for (const code of REASONS) assert.ok(seen.has(code), `${code} has a fixture`);
    for (const code of seen) assert.ok(REASONS.includes(code), `${code} is in the closed set`);
    assert.deepEqual([...PERMISSION_REASONS].sort(), [...REASONS].sort());
  });

  test('exactly one fixture is the 400 VALIDATION_ERROR case', () => {
    const bad = fixtures.filter((f) => f.steps[0].expect.status === 400);
    assert.deepEqual(bad.map((f) => f.test_id), ['prm-016']);
    assert.equal(bad[0].source, 'C-PRM-5');
  });

  test('the clean toy passes every permission fixture', async () => {
    const { report } = await runToy();
    assert.deepEqual(describeFails(report), []);
    assert.equal(report.totals.pass, EXPECTED_IDS.length);
    assert.equal(report.totals.fail, 0);
    assert.equal(report.totals.note, 0);
    assert.equal(report.totals.skip, 0);
    assert.equal(exitCode(report), 0);
  });

  test(`permit-self-approval fails exactly ${SELF_APPROVAL_ID}`, async () => {
    assert.ok(DEFECTS.includes('permit-self-approval'));
    const { report } = await runToy({ defects: ['permit-self-approval'] });
    assert.deepEqual(describeFails(report), [SELF_APPROVAL_ID]);
    assert.equal(exitCode(report), 1);
    const r = report.results.find((x) => x.test_id === SELF_APPROVAL_ID);
    assert.match(JSON.stringify(r), /SELF_APPROVAL/);
  });

  test('a target without permission_probe skips every permission fixture', async () => {
    const raw = JSON.parse(readFileSync(TARGET, 'utf8'));
    raw.capabilities = raw.capabilities.filter((c) => c !== 'permission_probe');
    const scratch = path.join(RUNNER, 'test', 'data', 'no-permission-probe.target.json');
    const { writeFileSync, mkdirSync, rmSync } = await import('node:fs');
    mkdirSync(path.dirname(scratch), { recursive: true });
    writeFileSync(scratch, JSON.stringify(raw));
    try {
      const target = await loadTarget(scratch);
      const { report } = await runToy({ target });
      assert.equal(report.totals.skip, EXPECTED_IDS.length);
      assert.equal(report.totals.pass, 0);
      assert.equal(report.totals.fail, 0);
      assert.equal(exitCode(report), 0);
    } finally {
      rmSync(scratch, { force: true });
    }
  });

  test('the report never contains the API key', async () => {
    const { report } = await runToy();
    assert.ok(!JSON.stringify(report).includes(API_KEY), 'api key leaked');
  });
});

describe('decidePermission is a pure function (C-PRM-5)', () => {
  const base = () => ({
    subject: { kind: 'user', id: 'u1', roles: ['operator'], work_center: 'wc-a' },
    verb: 'start',
    resource: { work_center: 'wc-a', workflow_instance: 'wi-1' },
    grants: [],
  });

  test('the same request always gives the same answer and the input is untouched', () => {
    const req = base();
    const snapshot = JSON.stringify(req);
    const a = decidePermission(req);
    const b = decidePermission(req);
    assert.deepEqual(a, { allowed: true, reason: 'OK' });
    assert.deepEqual(a, b);
    assert.equal(JSON.stringify(req), snapshot);
  });

  test('precedence: NO_ROLE wins over WRONG_WORK_CENTER, which wins over GRANT_SCOPE_OWN', () => {
    const req = base();
    req.subject.roles = [];
    req.subject.work_center = 'wc-b';
    assert.equal(decidePermission(req).reason, 'NO_ROLE');
    req.subject.roles = ['operator'];
    assert.equal(decidePermission(req).reason, 'WRONG_WORK_CENTER');
    req.grants = [{ from_work_center: 'wc-b', to_work_center: 'wc-a', scope: 'own' }];
    req.resource.owner = 'u2';
    assert.equal(decidePermission(req).reason, 'OK', 'start is not scoped by ownership');
    req.verb = 'control:abort';
    assert.equal(decidePermission(req).reason, 'GRANT_SCOPE_OWN');
  });

  test('approval reasons are distinct: SELF_APPROVAL, then SAME_PERSON_TWICE, then QUORUM_NOT_MET', () => {
    const req = base();
    req.subject.roles = ['operations_lead'];
    req.verb = 'approve_change';
    req.policy = { quorum: [{ role: 'process_engineer' }, { role: 'operations_lead' }], separation_of_duties: 'strict' };
    req.resource.change = { author: 'u3', approvals: [{ by: 'u3', role: 'process_engineer' }, { by: 'u4', role: 'operations_lead' }] };
    assert.equal(decidePermission(req).reason, 'SELF_APPROVAL');
    req.resource.change.approvals = [{ by: 'u4', role: 'process_engineer' }, { by: 'u4', role: 'operations_lead' }];
    assert.equal(decidePermission(req).reason, 'SAME_PERSON_TWICE');
    req.resource.change.approvals = [{ by: 'u4', role: 'process_engineer' }];
    assert.equal(decidePermission(req).reason, 'QUORUM_NOT_MET');
    req.resource.change.approvals = [{ by: 'u4', role: 'process_engineer' }, { by: 'u5', role: 'operations_lead' }];
    assert.deepEqual(decidePermission(req), { allowed: true, reason: 'OK' });
  });

  test('a malformed request throws rather than deciding', () => {
    assert.throws(() => decidePermission({ subject: {}, verb: 'start' }), /subject/);
    assert.throws(() => decidePermission({ ...base(), verb: 'delete' }), /verb/);
    assert.throws(() => decidePermission(null), /object/);
  });
});
