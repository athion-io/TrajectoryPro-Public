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

// Runs the outbound-only (relay door) fixtures rly-* against the in-process
// toy. The clean toy passes rly-001..003 and records rly-004 as `note:
// attested` (the toy attests C-RLY-4 in its target profile). The
// `non-idempotent-invoke` defect must degrade rly-002 (SHOULD) to a note
// and nothing else: every other rly-* and every agt-* outcome stays as in
// the clean run, with the one allowance that agt-015 (IMPL-DEFINED) may
// record a different variant. A target that does not attest C-RLY-4 skips
// rly-004; it is never a pass from nothing.

import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures, loadTarget } from '../src/load.mjs';
import { runSuite, exitCode } from '../src/run.mjs';
import { makeToy } from './toy-container.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const TARGET = join(ROOT, 'targets', 'toy.target.json');

const RLY_IDS = ['rly-001', 'rly-002', 'rly-003', 'rly-004'];

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

async function runAll({ defects = [], target: targetOverride, wrapFetch = (f) => f } = {}) {
  const clock = drivingClock();
  const toy = makeToy({ apiKey: 'k', defects, clock });
  clock.attach(toy);
  const fixtures = await loadFixtures(ROOT, { categories: ['agent-action'] });
  const target = targetOverride ?? await loadTarget(TARGET);
  return runSuite({ fixtures, target, apiKey: 'k', fetch: wrapFetch(toy.fetch), clock, fixturesCommit: 'test' });
}

/** A fetch that answers the offline action's invoke with a fixed error instead of asking the toy. */
function offlineInvokeAnswers(status, code) {
  return (realFetch) => async (url, init) => {
    if (String(url).includes('/actions/act-offline/invoke')) {
      return new Response(JSON.stringify({ error: { code, message: 'fake' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return realFetch(url, init);
  };
}

const byId = (report) => Object.fromEntries(report.results.map((r) => [r.test_id, r]));
const rlyOnly = (report) => report.results.filter((r) => r.test_id.startsWith('rly-'));
const describeFails = (report) =>
  report.results.filter((r) => r.outcome === 'fail').map((r) => `${r.test_id}: ${r.reason}`).join('\n');

describe('rly fixtures vs clean toy', () => {
  let report;
  let r;
  before(async () => { report = await runAll(); r = byId(report); });

  test('rly-001..004 are present, in the agent-action category', () => {
    for (const id of RLY_IDS) assert.ok(r[id], `${id} present`);
  });

  test('nothing in the suite fails and the exit code is 0', () => {
    assert.equal(report.totals.fail, 0, describeFails(report));
    assert.equal(exitCode(report), 0);
  });

  test('rly-001 (offline agent → 409 AGENT_UNAVAILABLE) passes', () => {
    assert.equal(r['rly-001'].level, 'MUST');
    assert.equal(r['rly-001'].outcome, 'pass', r['rly-001'].reason);
    assert.equal(r['rly-001'].evidence[0].status, 409);
    assert.equal(r['rly-001'].evidence[0].code, 'AGENT_UNAVAILABLE');
  });

  test('rly-002 (same ids twice → same instance_id) is a SHOULD that passes', () => {
    assert.equal(r['rly-002'].level, 'SHOULD');
    assert.equal(r['rly-002'].outcome, 'pass', r['rly-002'].reason);
  });

  test('rly-003 (different step_instance_id → different instance_id) passes', () => {
    assert.equal(r['rly-003'].level, 'MUST');
    assert.equal(r['rly-003'].outcome, 'pass', r['rly-003'].reason);
  });

  test('rly-004 (no inbound port) is a note: attested, never a pass', () => {
    assert.equal(r['rly-004'].level, 'MUST');
    assert.equal(r['rly-004'].outcome, 'note', r['rly-004'].reason);
    assert.match(r['rly-004'].reason, /^attested/);
    assert.match(r['rly-004'].reason, /C-RLY-4/);
  });

  test('every rly result carries evidence', () => {
    for (const x of rlyOnly(report)) {
      assert.ok(Array.isArray(x.evidence) && x.evidence.length > 0, `${x.test_id} has evidence`);
    }
  });

  test('rly-002 and rly-003 never read meta.idempotent', async () => {
    const fixtures = await loadFixtures(ROOT, { categories: ['agent-action'] });
    for (const f of fixtures.filter((x) => x.test_id === 'rly-002' || x.test_id === 'rly-003')) {
      assert.ok(!JSON.stringify(f).includes('idempotent'), `${f.test_id} does not mention idempotent`);
    }
  });
});

describe('rly-001..003 run only against doors', () => {
  test('rly-001..003 require the outbound_only capability', async () => {
    const fixtures = await loadFixtures(ROOT, { categories: ['agent-action'] });
    for (const f of fixtures.filter((x) => ['rly-001', 'rly-002', 'rly-003'].includes(x.test_id))) {
      assert.ok(f.requires.includes('outbound_only'), `${f.test_id} requires outbound_only`);
    }
  });

  test('a target without outbound_only skips rly-001..003 and still notes rly-004', async () => {
    const target = await loadTarget(TARGET);
    target.capabilities = target.capabilities.filter((c) => c !== 'outbound_only');
    const r = byId(await runAll({ target }));
    for (const id of ['rly-001', 'rly-002', 'rly-003']) {
      assert.equal(r[id].outcome, 'skip', `${id}: ${r[id].reason}`);
      assert.match(r[id].reason, /outbound_only/);
    }
    assert.equal(r['rly-004'].outcome, 'note');
  });
});

describe('rly-001 against doors that answer differently', () => {
  test('409 with a code other than AGENT_UNAVAILABLE fails', async () => {
    const r = byId(await runAll({ wrapFetch: offlineInvokeAnswers(409, 'SERVICE_UNAVAILABLE') }))['rly-001'];
    assert.equal(r.outcome, 'fail', r.reason);
    assert.match(r.reason, /AGENT_UNAVAILABLE/);
  });

  test('503 is a note whatever the code says', async () => {
    const r = byId(await runAll({ wrapFetch: offlineInvokeAnswers(503, 'SERVICE_UNAVAILABLE') }))['rly-001'];
    assert.equal(r.outcome, 'note', r.reason);
    assert.match(r.reason, /503/);
  });

  test('201 (the door accepted and will hang) fails', async () => {
    const wrap = (realFetch) => async (url, init) => {
      if (String(url).includes('/actions/act-offline/invoke')) {
        return new Response(JSON.stringify({ data: { instance_id: 'hang-1', state: 'RECEIVED' } }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return realFetch(url, init);
    };
    const r = byId(await runAll({ wrapFetch: wrap }))['rly-001'];
    assert.equal(r.outcome, 'fail', r.reason);
  });
});

describe('rly fixtures vs the bad-envelope toy', () => {
  test('rly-002 and rly-003 read the invoke envelope, so neither passes', async () => {
    const r = byId(await runAll({ defects: ['bad-envelope'] }));
    assert.notEqual(r['rly-002'].outcome, 'pass');
    assert.notEqual(r['rly-003'].outcome, 'pass');
  });
});

describe('rly-004 against a target that does not attest', () => {
  test('no attestations block → skip naming C-RLY-4', async () => {
    const target = await loadTarget(TARGET);
    delete target.attestations;
    const r = byId(await runAll({ target }))['rly-004'];
    assert.equal(r.outcome, 'skip', r.reason);
    assert.match(r.reason, /C-RLY-4/);
  });

  test('attestation explicitly false → skip', async () => {
    const target = await loadTarget(TARGET);
    target.attestations = { 'C-RLY-4': false };
    const r = byId(await runAll({ target }))['rly-004'];
    assert.equal(r.outcome, 'skip', r.reason);
  });
});

describe('rly fixtures vs the non-idempotent-invoke toy', () => {
  let clean;
  let broken;
  let brokenReport;
  before(async () => {
    clean = byId(await runAll());
    brokenReport = await runAll({ defects: ['non-idempotent-invoke'] });
    broken = byId(brokenReport);
  });

  test('rly-002 degrades to a SHOULD-not-met note', () => {
    assert.equal(broken['rly-002'].outcome, 'note', broken['rly-002'].reason);
    assert.match(broken['rly-002'].reason, /^SHOULD not met: /);
    assert.match(broken['rly-002'].reason, /instance_id/);
  });

  test('nothing fails and the exit code is still 0', () => {
    assert.equal(brokenReport.totals.fail, 0, describeFails(brokenReport));
    assert.equal(exitCode(brokenReport), 0);
  });

  test('every other rly outcome is unchanged', () => {
    for (const id of RLY_IDS.filter((x) => x !== 'rly-002')) {
      assert.equal(broken[id].outcome, clean[id].outcome, `${id}: ${broken[id].reason}`);
    }
  });

  test('every agt outcome is unchanged (agt-015 may only move between pass and note)', () => {
    for (const id of Object.keys(clean).filter((x) => x.startsWith('agt-'))) {
      if (id === 'agt-015') {
        assert.ok(['pass', 'note'].includes(broken[id].outcome), `${id}: ${broken[id].outcome} ${broken[id].reason}`);
        continue;
      }
      assert.equal(broken[id].outcome, clean[id].outcome, `${id}: ${broken[id].reason}`);
    }
  });
});
