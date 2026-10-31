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

// Lints every committed fixture across all categories: the loader's own
// rules (levels, sources, requires) plus the rule that an `sse_read` step
// must assert `$.ended` or carry `until_state`, so a stream timeout can
// never pass silently.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadFixtures, CATEGORIES } from '../src/load.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));

const present = CATEGORIES.filter((c) => existsSync(join(ROOT, c, 'fixtures')));

describe('fixture levels and sources', () => {
  test('at least one category has fixtures', async () => {
    assert.ok(present.includes('agent-action'), 'agent-action fixtures directory exists');
  });

  for (const category of present) {
    test(`${category}: every fixture passes the loader lint`, async () => {
      const fixtures = await loadFixtures(ROOT, { categories: [category] });
      assert.ok(fixtures.length > 0, `${category} has fixtures`);
      const files = readdirSync(join(ROOT, category, 'fixtures')).filter((f) => f.endsWith('.json'));
      assert.equal(fixtures.length, files.length, 'one fixture per file');
      for (const f of fixtures) {
        if (f.level === 'MUST' || f.level === 'SHOULD') {
          assert.equal(typeof f.source, 'string', `${f.test_id} has a source`);
          assert.ok(f.source.length > 0, `${f.test_id} source is not empty`);
        }
        if (f.level.startsWith('EXTENSION:')) {
          assert.ok(f.requires.includes(f.level.slice('EXTENSION:'.length)), `${f.test_id} requires its extension`);
        }
      }
    });

    test(`${category}: fixture file names are <test_id>-<slug>.json`, async () => {
      const files = readdirSync(join(ROOT, category, 'fixtures')).filter((f) => f.endsWith('.json'));
      const fixtures = await loadFixtures(ROOT, { categories: [category] });
      const ids = new Set(fixtures.map((f) => f.test_id));
      for (const file of files) {
        const m = file.match(/^([a-z]+-\d{3})-[a-z0-9-]+\.json$/);
        assert.ok(m, `${file} matches <test_id>-<slug>.json`);
        assert.ok(ids.has(m[1]), `${file} names a fixture test_id`);
      }
    });
  }
});

describe('sse_read steps cannot time out silently', () => {
  for (const category of present) {
    test(`${category}: every sse_read asserts $.ended or has until_state`, async () => {
      const fixtures = await loadFixtures(ROOT, { categories: [category] });
      for (const f of fixtures) {
        const steps = [...(f.setup ?? []), ...f.steps, ...(f.teardown ?? [])];
        for (const step of steps) {
          if (step.kind !== 'sse_read') continue;
          const asserts = step.expect?.json ?? [];
          const endedAsserted = asserts.some((a) => a.path === '$.ended');
          assert.ok(
            endedAsserted || (Array.isArray(step.until_state) && step.until_state.length > 0),
            `${f.test_id} step ${step.id ?? '?'}: sse_read must assert $.ended or set until_state`,
          );
        }
      }
    });
  }
});
