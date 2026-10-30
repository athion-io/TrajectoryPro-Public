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

// Runs the committed agent-action fixtures against the in-process toy
// container, clean and with each relevant defect switched on. The clean
// toy must pass every MUST/SHOULD (or note where the fixture is designed
// to), and each defect must trip exactly the fixtures that cover it.
// No sockets, no real timers: a driving clock advances the toy per tick.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures, loadTarget } from '../src/load.mjs';
import { runSuite, exitCode } from '../src/run.mjs';
import { makeToy } from './toy-container.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TARGET = join(ROOT, 'targets', 'toy.target.json');

/**
 * A clock whose `sleep` advances the toy one virtual millisecond at a time,
 * so toy transitions scheduled during a wait are delivered and an aborted
 * sleep (SSE reader satisfied) stops early.
 */
function drivingClock(start = 1_000) {
  let now = start;
  let toy = null;
  return {
    now: () => now,
    attach(t) { toy = t; },
    async sleep(ms, signal) {
      for (let i = 0; i < ms; i += 1) {
        if (signal?.aborted) return;
        now += 1;
        await toy.tick(1);
      }
    },
  };
}

async function runAgentAction({ defects = [], only } = {}) {
  const clock = drivingClock();
  const toy = makeToy({ apiKey: 'k', defects, clock });
  clock.attach(toy);
  let fixtures = await loadFixtures(ROOT, { categories: ['agent-action'] });
  if (only) fixtures = fixtures.filter((f) => only.includes(f.test_id));
  const target = await loadTarget(TARGET);
  return runSuite({ fixtures, target, apiKey: 'k', fetch: toy.fetch, clock, fixturesCommit: 'test' });
}

const byId = (report) => Object.fromEntries(report.results.map((r) => [r.test_id, r]));
const describeFails = (report) =>
  report.results.filter((r) => r.outcome === 'fail').map((r) => `${r.test_id}: ${r.reason}`).join('\n');

describe('agent-action fixtures vs clean toy', () => {
  let report;
  before(async () => { report = await runAgentAction(); });

  test('every fixture in the brief table is present', () => {
    const ids = report.results.map((r) => r.test_id);
    const expected = [
      'agt-001', 'agt-002', 'agt-003', 'agt-004', 'agt-005',
      'agt-010', 'agt-011', 'agt-012', 'agt-013', 'agt-014', 'agt-015',
      'agt-020', 'agt-021', 'agt-022', 'agt-023', 'agt-024', 'agt-025', 'agt-026', 'agt-027', 'agt-028',
      'agt-030', 'agt-031', 'agt-032', 'agt-033', 'agt-034',
      'agt-040', 'agt-041', 'agt-050', 'agt-051',
      'agt-060', 'agt-061', 'agt-062',
    ];
    for (const id of expected) assert.ok(ids.includes(id), `${id} present`);
  });

  test('nothing fails and the exit code is 0', () => {
    assert.equal(report.totals.fail, 0, describeFails(report));
    assert.equal(exitCode(report), 0);
  });

  test('every MUST and SHOULD passes', () => {
    for (const r of report.results) {
      if (r.level !== 'MUST' && r.level !== 'SHOULD') continue;
      assert.equal(r.outcome, 'pass', `${r.test_id} (${r.level}): ${r.outcome} ${r.reason}`);
    }
  });

  test('IMPL-DEFINED fixtures pass against the toy', () => {
    for (const r of report.results) {
      if (r.level !== 'IMPL-DEFINED') continue;
      assert.equal(r.outcome, 'pass', `${r.test_id}: ${r.outcome} ${r.reason}`);
    }
  });

  test('change-guard extension fixtures skip (toy declares no extensions)', () => {
    const ext = report.results.filter((r) => r.level === 'EXTENSION:change-guard');
    assert.equal(ext.length, 3);
    for (const r of ext) {
      assert.equal(r.outcome, 'skip', `${r.test_id}: ${r.reason}`);
      assert.match(r.reason, /change-guard/);
    }
  });

  test('every result carries evidence except skips', () => {
    for (const r of report.results) {
      if (r.outcome === 'skip') continue;
      assert.ok(Array.isArray(r.evidence) && r.evidence.length > 0, `${r.test_id} has evidence`);
    }
  });

  test('evidence never contains the API key', () => {
    const text = JSON.stringify(report);
    assert.ok(!/"x-api-key":\s*"k"/i.test(text), 'key is redacted');
  });
});

/**
 * Expected outcome deltas per toy defect. `fails` are the fixtures the brief names
 * as the defect's direct victims. `cascadeFail` / `cascadeNote` are fixtures the same
 * defect genuinely breaks as well: every entry must carry a reason matching `reason`
 * (so an unrelated regression cannot hide inside the cascade). Everything else must
 * match the clean run exactly.
 *
 * bad-envelope strips the `{data,meta}` / `{error}` wrapper from EVERY response, so
 * any fixture that reads `$.data.*` or `$.error.*` (or captures `iid` from an invoke
 * in setup) cannot pass against it; MUST/IMPL-DEFINED victims fail, SHOULD victims
 * become notes. accept-any-command makes the toy accept a command in a state where
 * it must be refused; agt-028 (SHOULD, HOLD in COMPLETING) is the one SHOULD-level
 * fixture that probes the same rule, so it degrades to a note.
 */
const ENVELOPE_REASON = /nothing at (path|\$\.data)/;
const DEFECT_EXPECTATIONS = {
  'bad-envelope': {
    fails: ['agt-002', 'agt-010', 'agt-014'],
    cascadeFail: [
      'agt-001', 'agt-003', 'agt-011', 'agt-012', 'agt-013', 'agt-015',
      'agt-020', 'agt-021', 'agt-022', 'agt-023', 'agt-024', 'agt-025', 'agt-026', 'agt-027',
      'agt-030', 'agt-031', 'agt-032', 'agt-034',
    ],
    cascadeNote: ['agt-004', 'agt-005', 'agt-028', 'agt-033', 'agt-040', 'agt-041'],
    reason: ENVELOPE_REASON,
  },
  'accept-any-command': {
    fails: ['agt-020', 'agt-021'],
    cascadeFail: [],
    cascadeNote: ['agt-028'],
    reason: /expected 409/,
  },
  'no-auth': {
    fails: ['agt-002', 'agt-003'],
    cascadeFail: [],
    cascadeNote: [],
    reason: /./,
  },
};

describe('agent-action fixtures vs broken toys', () => {
  let clean;
  before(async () => { clean = byId(await runAgentAction()); });

  for (const [defect, exp] of Object.entries(DEFECT_EXPECTATIONS)) {
    test(`${defect}: ${exp.fails.join(', ')} fail (+${exp.cascadeFail.length} cascade fails, ${exp.cascadeNote.length} cascade notes)`, async () => {
      const report = await runAgentAction({ defects: [defect] });
      const fails = report.results.filter((r) => r.outcome === 'fail').map((r) => r.test_id).sort();
      assert.deepEqual(fails, [...exp.fails, ...exp.cascadeFail].sort(), describeFails(report));
      const broken = byId(report);
      for (const id of exp.cascadeFail) {
        assert.match(broken[id].reason ?? '', exp.reason, `${id} cascade fail reason: ${broken[id].reason}`);
      }
      for (const id of exp.cascadeNote) {
        assert.equal(broken[id].outcome, 'note', `${id}: ${broken[id].outcome} (${broken[id].reason})`);
        assert.equal(clean[id].outcome, 'pass', `${id} passes against the clean toy`);
        assert.match(broken[id].reason ?? '', exp.reason, `${id} cascade note reason: ${broken[id].reason}`);
      }
      const touched = new Set([...exp.fails, ...exp.cascadeFail, ...exp.cascadeNote]);
      for (const [id, r] of Object.entries(clean)) {
        if (touched.has(id)) continue;
        assert.equal(broken[id].outcome, r.outcome, `${id}: ${broken[id].outcome} (${broken[id].reason}) vs clean ${r.outcome}`);
      }
      // Every named failure is a MUST here, so the exit code flips.
      assert.equal(exitCode(report), 1);
    });
  }
});
