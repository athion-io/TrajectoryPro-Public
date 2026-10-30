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

// The config-connector suite against the toy's /conformance/v1/connector/apply
// probe and the committed synthetic before/after files. No sockets, no real
// timers: the toy is in process. The live fixtures (cfg-100..103) must skip
// unless a target declares `live_vendor: true` (D13).

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures, loadTarget } from '../src/load.mjs';
import { runSuite, exitCode } from '../src/run.mjs';
import { makeToy, DEFECTS } from './toy-container.mjs';

const RUNNER = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = path.resolve(RUNNER, '..');
const TARGET = path.join(CONTRACTS, 'targets', 'toy.target.json');
const FILES = path.join(CONTRACTS, 'config-connector', 'fixtures', 'files');
const API_KEY = 'toy-api-key-fixture';

const SYNTHETIC_IDS = ['cfg-001', 'cfg-002', 'cfg-003', 'cfg-004', 'cfg-005', 'cfg-006'];
const LIVE_IDS = ['cfg-100', 'cfg-101', 'cfg-102', 'cfg-103'];
const EXPECTED_IDS = [...SYNTHETIC_IDS, ...LIVE_IDS];
const PROFILES = ['deltav-fhx', 'mimic-xml'];

/** Which committed file each synthetic fixture sends, and which golden it expects back. */
const GOLDEN = {
  'cfg-001': { before: 'deltav-fhx/fake-pump.before.fhx', after: 'deltav-fhx/fake-pump.after-cfg-001.fhx' },
  'cfg-002': { before: 'mimic-xml/fake-tank.before.xml', after: 'mimic-xml/fake-tank.after-cfg-002.xml' },
  'cfg-003': { before: 'deltav-fhx/fake-pump.before.fhx' },
  'cfg-004': { before: 'deltav-fhx/fake-pump.before.fhx' },
  'cfg-005': { before: 'mimic-xml/fake-tank.before.xml', after: 'mimic-xml/fake-tank.after-cfg-005.xml' },
  'cfg-006': { before: 'deltav-fhx/fake-pump.before.fhx' },
};

function bytes(rel) {
  return readFileSync(path.join(FILES, rel));
}

function sha256(buf) {
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

function drivingClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    advance: (ms) => { now += ms; },
  };
}

function byId(report) {
  return new Map(report.results.map((r) => [r.test_id, r]));
}

function describeFails(report) {
  return report.results.filter((r) => r.outcome === 'fail').map((r) => r.test_id).sort();
}

function expectation(step, jsonPath) {
  return (step.expect?.json ?? []).find((a) => a.path === jsonPath);
}

async function runToy({ defects = [], target } = {}) {
  const toy = makeToy({ apiKey: API_KEY, defects });
  const fixtures = await loadFixtures(CONTRACTS, { categories: ['config-connector'] });
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

describe('config-connector fixtures', () => {
  let fixtures;
  let map;
  before(async () => {
    fixtures = await loadFixtures(CONTRACTS, { categories: ['config-connector'] });
    map = new Map(fixtures.map((f) => [f.test_id, f]));
  });

  test('the brief\'s fixture set is present', () => {
    assert.deepEqual(fixtures.map((f) => f.test_id).sort(), EXPECTED_IDS);
  });

  test('every fixture is MUST, cites a C-CFG source, requires connector_probe and probes /connector/apply', () => {
    for (const f of fixtures) {
      assert.equal(f.level, 'MUST', f.test_id);
      assert.match(f.source, /^C-CFG-[1-5]$/, f.test_id);
      assert.ok(f.requires.includes('connector_probe'), `${f.test_id} requires connector_probe`);
      assert.equal(f.steps.length, 1, `${f.test_id} is one apply call`);
      assert.equal(f.steps[0].probe, true, `${f.test_id} goes to probe_url`);
      assert.equal(f.steps[0].method, 'POST', f.test_id);
      assert.equal(f.steps[0].path, '/connector/apply', f.test_id);
      assert.equal(f.steps[0].body.mode, 'test', `${f.test_id} is test mode only (C-CFG-3)`);
      assert.ok(PROFILES.includes(f.steps[0].body.profile), `${f.test_id} names a known profile (C-CFG-5)`);
    }
  });

  test('exactly the cfg-1xx fixtures are tagged live; the synthetic ones are not', () => {
    for (const f of fixtures) {
      const live = (f.tags ?? []).includes('live');
      assert.equal(live, LIVE_IDS.includes(f.test_id), `${f.test_id} live tag`);
    }
  });

  test('both profiles are exercised by the synthetic fixtures', () => {
    const seen = new Set(SYNTHETIC_IDS.map((id) => map.get(id).steps[0].body.profile));
    assert.deepEqual([...seen].sort(), PROFILES);
  });

  test('every synthetic fixture sends the committed before file and pins its sha256', () => {
    for (const id of SYNTHETIC_IDS) {
      const f = map.get(id);
      const before = bytes(GOLDEN[id].before);
      assert.equal(f.steps[0].body.file_b64, before.toString('base64'), `${id} file_b64 is the committed before file`);
      if (f.steps[0].expect.status === 200) {
        assert.equal(expectation(f.steps[0], '$.data.before_hash')?.equals, sha256(before), `${id} pins before_hash`);
      }
    }
  });

  test('cfg-001, cfg-002 and cfg-005 expect their golden after file byte for byte', () => {
    for (const id of ['cfg-001', 'cfg-002', 'cfg-005']) {
      const f = map.get(id);
      const after = bytes(GOLDEN[id].after);
      assert.equal(expectation(f.steps[0], '$.data.after_b64')?.equals, after.toString('base64'), `${id} after_b64`);
      assert.equal(expectation(f.steps[0], '$.data.after_hash')?.equals, sha256(after), `${id} after_hash`);
      assert.equal(expectation(f.steps[0], '$.data.read_back.ok')?.equals, true, `${id} read_back.ok`);
    }
  });

  test('every golden after file differs from its before file in exactly one line', () => {
    for (const id of ['cfg-001', 'cfg-002', 'cfg-005']) {
      const before = bytes(GOLDEN[id].before).toString('utf8').split('\n');
      const after = bytes(GOLDEN[id].after).toString('utf8').split('\n');
      assert.equal(before.length, after.length, `${id} same line count`);
      const changed = before.filter((line, i) => line !== after[i]);
      assert.equal(changed.length, 1, `${id} changes one line`);
    }
  });

  test('committed files are LF-only and obviously synthetic', () => {
    for (const rel of new Set(Object.values(GOLDEN).flatMap((g) => [g.before, g.after]).filter(Boolean))) {
      const text = bytes(rel).toString('utf8');
      assert.ok(!text.includes('\r'), `${rel} has no CR`);
      assert.match(text, /synthetic/, `${rel} says it is synthetic`);
      assert.match(text, /FAKE_/, `${rel} names only FAKE_ objects`);
    }
  });

  test('cfg-003 is the stale case, cfg-004 the unknown item, cfg-006 the honest read-back', () => {
    assert.equal(map.get('cfg-003').steps[0].expect.status, 409);
    assert.equal(expectation(map.get('cfg-003').steps[0], '$.error.code')?.equals, 'STALE_VALUE');
    assert.equal(expectation(map.get('cfg-003').steps[0], '$.data')?.absent, true, 'stale apply returns no after file');
    assert.equal(map.get('cfg-004').steps[0].expect.status, 400);
    assert.equal(expectation(map.get('cfg-004').steps[0], '$.error.code')?.equals, 'ITEM_NOT_FOUND');
    assert.equal(map.get('cfg-006').steps[0].expect.status, 200);
    assert.equal(expectation(map.get('cfg-006').steps[0], '$.data.read_back.ok')?.equals, false);
    assert.equal(typeof expectation(map.get('cfg-006').steps[0], '$.data.read_back.mismatches[0].item')?.equals, 'string');
  });

  test('the clean toy passes every synthetic fixture and skips the live ones', async () => {
    const { report } = await runToy();
    assert.deepEqual(describeFails(report), []);
    assert.equal(report.totals.pass, SYNTHETIC_IDS.length);
    assert.equal(report.totals.fail, 0);
    assert.equal(report.totals.note, 0);
    assert.equal(report.totals.skip, LIVE_IDS.length);
    const results = byId(report);
    for (const id of LIVE_IDS) {
      assert.equal(results.get(id).outcome, 'skip', id);
      assert.match(results.get(id).reason, /live/, `${id} skip reason names the live tag`);
      assert.match(results.get(id).reason, /live_vendor/, `${id} skip reason names live_vendor`);
    }
    assert.equal(exitCode(report), 0);
  });

  test('lying-readback fails exactly cfg-006', async () => {
    assert.ok(DEFECTS.includes('lying-readback'));
    const { report } = await runToy({ defects: ['lying-readback'] });
    assert.deepEqual(describeFails(report), ['cfg-006']);
    assert.equal(exitCode(report), 1);
    assert.match(JSON.stringify(byId(report).get('cfg-006')), /read_back/);
  });

  test('a target with live_vendor: true no longer skips the live fixtures', async () => {
    const target = { ...(await loadTarget(TARGET)), live_vendor: true };
    const { report } = await runToy({ target });
    assert.equal(report.totals.skip, 0);
    const results = byId(report);
    for (const id of LIVE_IDS) assert.notEqual(results.get(id).outcome, 'skip', id);
    for (const id of SYNTHETIC_IDS) assert.equal(results.get(id).outcome, 'pass', id);
  });

  test('a target without connector_probe skips every fixture', async () => {
    const base = await loadTarget(TARGET);
    const target = { ...base, capabilities: base.capabilities.filter((c) => c !== 'connector_probe') };
    const { report } = await runToy({ target });
    assert.equal(report.totals.skip, EXPECTED_IDS.length);
    assert.equal(report.totals.pass, 0);
    assert.equal(exitCode(report), 0);
  });

  test('the report never contains the API key', async () => {
    const { report } = await runToy();
    assert.ok(!JSON.stringify(report).includes(API_KEY), 'api key leaked');
  });
});
