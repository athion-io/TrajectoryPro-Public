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

// The audit-trail suite against the toy's /conformance/v1 probe surface, the
// committed trails, and the offline `--audit-file` mode. No sockets, no real
// timers: the toy is in process and the CLI is spawned on local files only.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures, loadTarget } from '../src/load.mjs';
import { runSuite, exitCode } from '../src/run.mjs';
import { verifyChain, verifyTrailFile } from '../src/audit.mjs';
import { makeToy, DEFECTS } from './toy-container.mjs';
import { buildTrails, toJsonl, TRAILS_DIR, FAKE_SECRET } from './audit-trails.mjs';

const RUNNER = fileURLToPath(new URL('..', import.meta.url));
const CONTRACTS = path.resolve(RUNNER, '..');
const BIN = path.join(RUNNER, 'bin', 'trajectory-contracts.mjs');
const DATA = path.join(RUNNER, 'test', 'data', 'audit');
const API_KEY = 'toy-api-key-fixture';

const EXPECTED_IDS = ['aud-001', 'aud-002', 'aud-003', 'aud-004', 'aud-005', 'aud-006', 'aud-010'];

function drivingClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms) => { now += ms; },
    advance: (ms) => { now += ms; },
  };
}

function byId(report) {
  const out = new Map();
  for (const r of report.results) out.set(r.test_id, r);
  return out;
}

function describeFails(report) {
  return report.results.filter((r) => r.outcome === 'fail').map((r) => r.test_id).sort();
}

async function runToy({ defects = [] } = {}) {
  const toy = makeToy({ apiKey: API_KEY, defects });
  const target = await loadTarget(path.join(CONTRACTS, 'targets', 'toy.target.json'));
  const fixtures = await loadFixtures(CONTRACTS, { categories: ['audit-trail'] });
  const clock = drivingClock();
  const report = await runSuite({
    target,
    fixtures,
    apiKey: API_KEY,
    fetch: toy.fetch,
    clock,
    contractsRoot: CONTRACTS,
  });
  return { report, toy };
}

describe('audit-trail fixtures', () => {
  let fixtures;
  before(async () => {
    fixtures = await loadFixtures(CONTRACTS, { categories: ['audit-trail'] });
  });

  test('the brief\'s fixture set is present', () => {
    assert.deepEqual(fixtures.map((f) => f.test_id).sort(), EXPECTED_IDS);
  });

  test('every fixture is MUST, cites a C-AUD source, and requires audit_probe', () => {
    for (const f of fixtures) {
      assert.equal(f.level, 'MUST', f.test_id);
      assert.match(f.source, /^C-AUD-[1-8]$/, f.test_id);
      assert.ok(f.requires.includes('audit_probe'), `${f.test_id} requires audit_probe`);
    }
  });

  test('the clean toy passes every audit fixture', async () => {
    const { report } = await runToy();
    assert.deepEqual(describeFails(report), []);
    assert.equal(report.totals.pass, EXPECTED_IDS.length);
    assert.equal(report.totals.fail, 0);
    assert.equal(report.totals.note, 0);
    assert.equal(report.totals.skip, 0);
    assert.equal(exitCode(report), 0);
  });

  test('break-chain fails exactly aud-010', async () => {
    assert.ok(DEFECTS.includes('break-chain'));
    const { report } = await runToy({ defects: ['break-chain'] });
    assert.deepEqual(describeFails(report), ['aud-010']);
    assert.equal(exitCode(report), 1);
    const r = byId(report).get('aud-010');
    assert.match(JSON.stringify(r), /broken_link/);
  });

  test('the report never contains the API key or the fixture secret', async () => {
    const { report } = await runToy();
    const text = JSON.stringify(report);
    assert.ok(!text.includes(API_KEY), 'api key leaked');
    assert.ok(!text.includes(FAKE_SECRET), 'secret value leaked');
  });
});

describe('committed trails', () => {
  const trails = buildTrails();

  test('every trail file matches the generator byte for byte', () => {
    for (const [name, { events }] of Object.entries(trails)) {
      const file = path.join(TRAILS_DIR, `${name}.jsonl`);
      assert.ok(existsSync(file), `${name}.jsonl is committed`);
      assert.equal(readFileSync(file, 'utf8'), toJsonl(events), `${name}.jsonl drifted`);
    }
  });

  test('verifyChain reports exactly the pinned issues for each trail', () => {
    for (const [name, { events, issues }] of Object.entries(trails)) {
      assert.deepEqual(verifyChain(events), issues, name);
    }
  });

  test('the secret trail never has its secret in a verifier issue', () => {
    const issues = verifyChain(trails.secret.events);
    assert.ok(!JSON.stringify(issues).includes(FAKE_SECRET));
  });
});

describe('offline verifier', () => {
  const file = (n) => path.join(TRAILS_DIR, `${n}.jsonl`);

  test('verifyTrailFile: clean trail is 0', () => {
    const r = verifyTrailFile(file('good'));
    assert.equal(r.code, 0);
    assert.deepEqual(r.issues, []);
  });

  test('verifyTrailFile: tampered trails are 1 with the pinned issues', () => {
    for (const [name, { issues }] of Object.entries(buildTrails())) {
      if (name === 'good') continue;
      const r = verifyTrailFile(file(name));
      assert.equal(r.code, 1, name);
      assert.deepEqual(r.issues, issues, name);
    }
  });

  test('verifyTrailFile: unreadable or uncanonicalizable input is 2', () => {
    for (const name of ['not-json', 'non-object-event', 'lone-surrogate']) {
      const r = verifyTrailFile(path.join(DATA, `${name}.jsonl`));
      assert.equal(r.code, 2, name);
      assert.ok(r.error, `${name} carries an error message`);
    }
    assert.equal(verifyTrailFile(path.join(DATA, 'does-not-exist.jsonl')).code, 2);
  });

  function cli(args) {
    try {
      const stdout = execFileSync(process.execPath, [BIN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      return { status: 0, stdout, stderr: '' };
    } catch (e) {
      return { status: e.status, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
  }

  test('--audit-file exits 0 / 1 / 2 and never prints the secret', () => {
    const good = cli(['--audit-file', file('good')]);
    assert.equal(good.status, 0, good.stderr);

    const secret = cli(['--audit-file', file('secret')]);
    assert.equal(secret.status, 1);
    assert.match(secret.stdout + secret.stderr, /secret_in_payload/);
    assert.ok(!(secret.stdout + secret.stderr).includes(FAKE_SECRET));

    const altered = cli(['--audit-file', file('payload-altered')]);
    assert.equal(altered.status, 1);
    assert.match(altered.stdout + altered.stderr, /altered/);

    assert.equal(cli(['--audit-file', path.join(DATA, 'not-json.jsonl')]).status, 2);
    assert.equal(cli(['--audit-file', path.join(DATA, 'lone-surrogate.jsonl')]).status, 2);
    assert.equal(cli(['--audit-file', path.join(DATA, 'nope.jsonl')]).status, 2);
  });
});
