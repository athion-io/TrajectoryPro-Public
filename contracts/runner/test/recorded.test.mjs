import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTarget } from '../src/load.mjs';

const CONTRACTS = fileURLToPath(new URL('../..', import.meta.url));
const TARGETS = path.join(CONTRACTS, 'targets');
const RESULTS = path.join(CONTRACTS, 'results');

const targetFiles = readdirSync(TARGETS).filter((f) => f.endsWith('.target.json'));
const resultFiles = existsSync(RESULTS)
  ? readdirSync(RESULTS).filter((f) => f.endsWith('.json'))
  : [];

test('the recorded door target and its results are present', () => {
  assert.ok(targetFiles.includes('athion-door.target.json'));
  assert.ok(resultFiles.some((f) => /^athion-door-[0-9a-f]{8,40}\.json$/.test(f)));
});

for (const f of targetFiles) {
  test(`target ${f} loads against the target schema`, async () => {
    const t = await loadTarget(path.join(TARGETS, f));
    assert.equal(`${t.name}.target.json`, f);
  });
}

for (const f of resultFiles) {
  test(`results ${f} is a complete report with no failures`, () => {
    const r = JSON.parse(readFileSync(path.join(RESULTS, f), 'utf8'));
    assert.ok(targetFiles.includes(`${r.target}.target.json`), 'its target profile is recorded');
    assert.ok(f.startsWith(`${r.target}-`));
    assert.match(r.fixtures_commit, /^[0-9a-f]{40}$/);
    assert.ok(Array.isArray(r.results) && r.results.length > 0);
    const counted = { pass: 0, fail: 0, note: 0, skip: 0 };
    for (const x of r.results) counted[x.outcome] = (counted[x.outcome] ?? 0) + 1;
    assert.deepEqual(counted, r.totals);
    assert.equal(r.totals.fail, 0);
    assert.doesNotMatch(JSON.stringify(r), /X-API-Key"\s*:\s*"[^"]/);
  });
}
