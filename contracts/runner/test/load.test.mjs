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

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  lintFixture,
  loadFixtures,
  loadTarget,
  LintError,
  CAPABILITY_ROLES,
  FIXTURE_REQUIRED_KEYS,
  TARGET_REQUIRED_KEYS,
} from '../src/load.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(here, '..', '..', 'schema');
const scratchRoot = path.join(here, '.scratch');

/** A fixture that follows every lint rule. */
function validFixture() {
  return {
    test_id: 'agt-001',
    name: 'Invoke returns an instance id',
    category: 'agent-action',
    level: 'MUST',
    source: 'REST-05',
    tags: ['invoke'],
    requires: ['observable_action'],
    setup: [],
    steps: [
      {
        kind: 'request',
        method: 'POST',
        path: '/actions/{{roles.observable_action}}/invoke',
        body: { environment_oid: '{{roles.environment_oid}}' },
        expect: { status: 202 },
      },
    ],
    expected: {},
  };
}

function validTarget() {
  return {
    name: 'toy',
    base_url: 'http://127.0.0.1:1/trajectory/v1',
    auth: { mode: 'none', header: 'X-API-Key', scheme: '' },
    capabilities: ['observable_action', 'sse'],
    extensions: [],
    roles: { environment_oid: 'env-1', observable_action: 'act-1' },
    timeouts: { wait_s: 15, sse_s: 10 },
    known_failures: {},
  };
}

/** Writes a fixture tree under a fresh scratch dir and returns its root. */
function writeTree(files) {
  fs.mkdirSync(scratchRoot, { recursive: true });
  const root = fs.mkdtempSync(path.join(scratchRoot, 'tree-'));
  for (const [rel, obj] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, JSON.stringify(obj, null, 2));
  }
  return root;
}

describe('lintFixture', () => {
  test('a valid fixture passes', () => {
    assert.deepEqual(lintFixture(validFixture(), 'agt-001-invoke.json'), []);
  });

  test('a missing level is one problem naming the file', () => {
    const f = validFixture();
    delete f.level;
    const problems = lintFixture(f, 'agt-001-invoke.json');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /agt-001-invoke\.json/);
    assert.match(problems[0], /level/);
  });

  test('a level outside the enum is one problem', () => {
    const f = validFixture();
    f.level = 'MAYBE';
    const problems = lintFixture(f, 'agt-001-invoke.json');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /level/);
  });

  test('EXTENSION:<name> is an accepted level', () => {
    const f = validFixture();
    f.level = 'EXTENSION:change-guard';
    delete f.source;
    f.requires.push('change-guard');
    assert.deepEqual(lintFixture(f, 'agt-001-invoke.json'), []);
  });

  test('a MUST without source is one problem naming the file', () => {
    const f = validFixture();
    delete f.source;
    const problems = lintFixture(f, 'agt-001-invoke.json');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /agt-001-invoke\.json/);
    assert.match(problems[0], /source/);
  });

  test('a SHOULD without source is one problem', () => {
    const f = validFixture();
    f.level = 'SHOULD';
    delete f.source;
    assert.equal(lintFixture(f, 'agt-001-invoke.json').length, 1);
  });

  test('IMPL-DEFINED without source is fine', () => {
    const f = validFixture();
    f.level = 'IMPL-DEFINED';
    delete f.source;
    assert.deepEqual(lintFixture(f, 'agt-001-invoke.json'), []);
  });

  test('an undeclared role is one problem naming the file and the role', () => {
    const f = validFixture();
    f.steps[0].path = '/actions/{{roles.fast_action}}/invoke';
    const problems = lintFixture(f, 'agt-001-invoke.json');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /agt-001-invoke\.json/);
    assert.match(problems[0], /fast_action/);
  });

  test('a role implied by a capability needs no explicit entry', () => {
    const f = validFixture();
    f.requires = ['sse'];
    assert.deepEqual(lintFixture(f, 'agt-001-invoke.json'), []);
  });

  test('environment_oid is always available', () => {
    const f = validFixture();
    f.requires = [];
    f.steps[0].path = '/actions/x/invoke';
    assert.deepEqual(lintFixture(f, 'agt-001-invoke.json'), []);
  });

  test('test_id must be the file name prefix', () => {
    const problems = lintFixture(validFixture(), 'agt-002-invoke.json');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /test_id/);
  });

  test('test_id must use a known prefix', () => {
    const f = validFixture();
    f.test_id = 'xyz-001';
    const problems = lintFixture(f, 'xyz-001-invoke.json');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /test_id/);
  });

  test('an EXTENSION fixture must list its extension in requires', () => {
    const f = validFixture();
    f.level = 'EXTENSION:change-guard';
    delete f.source;
    const problems = lintFixture(f, 'agt-001-invoke.json');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /change-guard/);
  });

  test('a non-object fixture is reported, not thrown', () => {
    const problems = lintFixture([], 'agt-001-invoke.json');
    assert.equal(problems.length, 1);
    assert.match(problems[0], /agt-001-invoke\.json/);
  });
});

describe('loadFixtures', () => {
  before(() => fs.mkdirSync(scratchRoot, { recursive: true }));
  after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }));

  test('loads fixtures from <category>/fixtures and sorts by test_id', async () => {
    const b = validFixture();
    b.test_id = 'agt-002';
    const root = writeTree({
      'agent-action/fixtures/agt-002-second.json': b,
      'agent-action/fixtures/agt-001-first.json': validFixture(),
      'agent-action/fixtures/vectors/ignored.json': { not: 'a fixture' },
    });
    const fixtures = await loadFixtures(root, { categories: ['agent-action'] });
    assert.deepEqual(fixtures.map((f) => f.test_id), ['agt-001', 'agt-002']);
    assert.equal(fixtures[0].file, path.join('agent-action', 'fixtures', 'agt-001-first.json'));
    assert.deepEqual(Object.keys(fixtures[0]), Object.keys(validFixture()));
  });

  test('a duplicate test_id is one problem naming the file', async () => {
    const root = writeTree({
      'agent-action/fixtures/agt-001-first.json': validFixture(),
      'agent-action/fixtures/agt-001-again.json': validFixture(),
    });
    const err = await loadFixtures(root, { categories: ['agent-action'] }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof LintError);
    assert.equal(err.problems.length, 1);
    assert.match(err.problems[0], /agt-001-again\.json/);
    assert.match(err.problems[0], /duplicate/);
    assert.match(err.message, /agt-001-again\.json/);
  });

  test('every problem across files is listed in one error', async () => {
    const noLevel = validFixture();
    delete noLevel.level;
    const noSource = validFixture();
    noSource.test_id = 'agt-002';
    delete noSource.source;
    const root = writeTree({
      'agent-action/fixtures/agt-001-first.json': noLevel,
      'agent-action/fixtures/agt-002-second.json': noSource,
    });
    const err = await loadFixtures(root, { categories: ['agent-action'] }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof LintError);
    assert.equal(err.problems.length, 2);
  });

  test('a file that is not JSON is one problem naming the file', async () => {
    const root = writeTree({ 'agent-action/fixtures/agt-001-first.json': validFixture() });
    fs.writeFileSync(path.join(root, 'agent-action', 'fixtures', 'agt-002-bad.json'), '{ nope');
    const err = await loadFixtures(root, { categories: ['agent-action'] }).then(
      () => null,
      (e) => e,
    );
    assert.ok(err instanceof LintError);
    assert.equal(err.problems.length, 1);
    assert.match(err.problems[0], /agt-002-bad\.json/);
  });

  test('a category directory that does not exist is an error', async () => {
    const root = writeTree({});
    await assert.rejects(loadFixtures(root, { categories: ['permission'] }), LintError);
  });
});

describe('loadTarget', () => {
  before(() => fs.mkdirSync(scratchRoot, { recursive: true }));
  after(() => fs.rmSync(scratchRoot, { recursive: true, force: true }));

  function writeTarget(obj) {
    const root = writeTree({ 'x.target.json': obj });
    return path.join(root, 'x.target.json');
  }

  test('a valid target loads', async () => {
    const t = await loadTarget(writeTarget(validTarget()));
    assert.equal(t.name, 'toy');
    assert.deepEqual(t.capabilities, ['observable_action', 'sse']);
  });

  test('sse without an observable_action role is rejected', async () => {
    const t = validTarget();
    delete t.roles.observable_action;
    const err = await loadTarget(writeTarget(t)).then(() => null, (e) => e);
    assert.ok(err instanceof LintError);
    assert.equal(err.problems.length, 1);
    assert.match(err.problems[0], /observable_action/);
    assert.match(err.problems[0], /sse/);
  });

  test('an unknown capability is rejected', async () => {
    const t = validTarget();
    t.capabilities.push('teleport');
    await assert.rejects(loadTarget(writeTarget(t)), (e) => {
      assert.ok(e instanceof LintError);
      assert.match(e.problems[0], /teleport/);
      return true;
    });
  });

  test('a missing environment_oid role is rejected', async () => {
    const t = validTarget();
    delete t.roles.environment_oid;
    await assert.rejects(loadTarget(writeTarget(t)), (e) => {
      assert.match(e.problems[0], /environment_oid/);
      return true;
    });
  });

  test('a missing required key is rejected', async () => {
    const t = validTarget();
    delete t.base_url;
    await assert.rejects(loadTarget(writeTarget(t)), (e) => {
      assert.match(e.problems[0], /base_url/);
      return true;
    });
  });

  test('a target file that does not exist is rejected', async () => {
    await assert.rejects(loadTarget(path.join(scratchRoot, 'missing.target.json')), LintError);
  });

  test('attestations is an optional map of clause id -> boolean', async () => {
    const t = await loadTarget(writeTarget({ ...validTarget(), attestations: { 'C-RLY-4': true } }));
    assert.deepEqual(t.attestations, { 'C-RLY-4': true });
    await assert.rejects(loadTarget(writeTarget({ ...validTarget(), attestations: ['C-RLY-4'] })), (e) => {
      assert.match(e.problems[0], /attestations/);
      return true;
    });
    await assert.rejects(loadTarget(writeTarget({ ...validTarget(), attestations: { 'C-RLY-4': 'yes' } })), (e) => {
      assert.match(e.problems[0], /attestations\.C-RLY-4/);
      return true;
    });
  });
});

describe('capability roles', () => {
  test('sse implies observable_action', () => {
    assert.deepEqual(CAPABILITY_ROLES.sse, ['observable_action']);
  });
});

describe('schemas agree with the linter', () => {
  test('fixture schema lists the same required keys as lintFixture', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, 'contract-fixture-schema.json'), 'utf8'));
    assert.deepEqual([...schema.required].sort(), [...FIXTURE_REQUIRED_KEYS].sort());
  });

  test('target schema lists the same required keys as loadTarget', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, 'target-schema.json'), 'utf8'));
    assert.deepEqual([...schema.required].sort(), [...TARGET_REQUIRED_KEYS].sort());
  });

  test('target schema capabilities match CAPABILITY_ROLES', () => {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, 'target-schema.json'), 'utf8'));
    assert.deepEqual(
      [...schema.properties.capabilities.items.enum].sort(),
      Object.keys(CAPABILITY_ROLES).sort(),
    );
  });
});
