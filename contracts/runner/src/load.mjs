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

// Loads and lints contract fixtures and target profiles.
//
// `lintFixture` is the executable check. The JSON Schemas in `../../schema/`
// describe the same shapes for readers in other languages; a test keeps the
// two lists of required keys in step.

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * @typedef {object} Fixture
 * @property {string} test_id
 * @property {string} name
 * @property {string} category
 * @property {string} level  MUST | SHOULD | IMPL-DEFINED | EXTENSION:<name>
 * @property {string} [source]  REST_Protocol section or contract clause (required for MUST and SHOULD)
 * @property {string[]} tags
 * @property {string[]} requires  capabilities, roles and extensions the target must declare
 * @property {object[]} [setup]
 * @property {object[]} steps
 * @property {object} [expected]
 * @property {object[]} [teardown]
 * @property {string} [file]  path relative to the contracts root, set by loadFixtures (not enumerable)
 */

/**
 * @typedef {object} Target
 * @property {string} name
 * @property {string} base_url
 * @property {string} [probe_url]
 * @property {{mode: string, header?: string, scheme?: string}} auth
 * @property {string[]} capabilities
 * @property {string[]} [extensions]
 * @property {Record<string, string>} roles
 * @property {{wait_s?: number, sse_s?: number}} [timeouts]
 * @property {Record<string, string>} [known_failures]
 * @property {boolean} [live_vendor]
 */

/** Keys every fixture must have. Mirrored by `schema/contract-fixture-schema.json`. */
export const FIXTURE_REQUIRED_KEYS = Object.freeze([
  'test_id',
  'name',
  'category',
  'level',
  'tags',
  'requires',
  'steps',
]);

/** Keys every target profile must have. Mirrored by `schema/target-schema.json`. */
export const TARGET_REQUIRED_KEYS = Object.freeze(['name', 'base_url', 'auth', 'capabilities', 'roles']);

/** Fixture categories and the directories they live in. */
export const CATEGORIES = Object.freeze(['agent-action', 'permission', 'audit-trail', 'config-connector']);

/** Levels other than `EXTENSION:<name>`. */
export const FIXED_LEVELS = Object.freeze(['MUST', 'SHOULD', 'IMPL-DEFINED']);

const TEST_ID_PATTERN = /^(agt|rly|prm|aud|cfg)-[a-z0-9-]+$/;
const LEVEL_PATTERN = /^(MUST|SHOULD|IMPL-DEFINED|EXTENSION:[a-z0-9-]+)$/;
const EXTENSION_PREFIX = 'EXTENSION:';
const ROLE_PLACEHOLDER = /\{\{roles\.([A-Za-z0-9_]+)\}\}/g;

/**
 * Capability → roles a target must map when it declares that capability.
 * Fixtures may use `{{roles.X}}` for any role implied by a capability they require.
 * Later tasks extend this map as they add capabilities.
 */
export const CAPABILITY_ROLES = Object.freeze({
  observable_action: ['observable_action'],
  opaque_action: ['opaque_action'],
  commands: [],
  sse: ['observable_action'],
  list: [],
  delete: [],
  cors: ['cors_origin'],
  outbound_only: [],
  permission_probe: [],
  audit_probe: [],
  connector_probe: [],
});

/** Roles every target provides whether or not a capability implies them. */
export const ALWAYS_ROLES = Object.freeze(['environment_oid']);

/** Thrown by loadFixtures and loadTarget. `problems` lists every finding, one string each. */
export class LintError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`${problems.length} lint problem${problems.length === 1 ? '' : 's'}:\n  ${problems.join('\n  ')}`);
    this.name = 'LintError';
    this.problems = problems;
  }
}

/**
 * Checks one fixture against the lint rules. Pure: no I/O.
 * @param {unknown} obj  the parsed fixture
 * @param {string} file  file name or path, used in every problem string
 * @returns {string[]} problems; empty means the fixture is fine
 */
export function lintFixture(obj, file) {
  const problems = [];
  const problem = (text) => problems.push(`${file}: ${text}`);

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    problem('fixture must be a JSON object');
    return problems;
  }

  const missing = FIXTURE_REQUIRED_KEYS.filter((k) => !(k in obj));
  if (missing.length > 0) problem(`missing required key(s): ${missing.join(', ')}`);

  const { test_id, level, requires } = obj;
  const base = path.basename(file);

  if (typeof test_id === 'string') {
    if (!TEST_ID_PATTERN.test(test_id)) {
      problem(`test_id "${test_id}" must start with agt-, rly-, prm-, aud- or cfg-`);
    } else if (!base.startsWith(`${test_id}-`)) {
      problem(`test_id "${test_id}" must be the file name prefix (expected ${test_id}-<slug>.json)`);
    }
  }

  const levelOk = typeof level === 'string' && LEVEL_PATTERN.test(level);
  if ('level' in obj && !levelOk) {
    problem(`level "${level}" is not MUST, SHOULD, IMPL-DEFINED or EXTENSION:<name>`);
  }

  if (levelOk && (level === 'MUST' || level === 'SHOULD') && typeof obj.source !== 'string') {
    problem(`a ${level} fixture must cite a source (for example "REST-05" or "C-AUD-3")`);
  }

  const requiresList = Array.isArray(requires) ? requires.filter((r) => typeof r === 'string') : [];
  if ('requires' in obj && !Array.isArray(requires)) problem('requires must be an array of strings');

  if (levelOk && level.startsWith(EXTENSION_PREFIX)) {
    const ext = level.slice(EXTENSION_PREFIX.length);
    if (!requiresList.includes(ext)) problem(`an ${level} fixture must list "${ext}" in requires`);
  }

  const allowedRoles = new Set(ALWAYS_ROLES);
  for (const r of requiresList) {
    allowedRoles.add(r);
    for (const implied of CAPABILITY_ROLES[r] ?? []) allowedRoles.add(implied);
  }
  const used = new Set();
  for (const m of JSON.stringify(obj).matchAll(ROLE_PLACEHOLDER)) used.add(m[1]);
  for (const role of [...used].sort()) {
    if (!allowedRoles.has(role)) {
      problem(`{{roles.${role}}} is used but "${role}" is not in requires and no required capability implies it`);
    }
  }

  return problems;
}

/**
 * Reads every `<rootDir>/<category>/fixtures/*.json` (top level only), lints each,
 * checks test_id uniqueness across all of them, and returns them sorted by test_id.
 * @param {string} rootDir  the `contracts/` directory
 * @param {{categories: string[]}} options
 * @returns {Promise<Fixture[]>}
 * @throws {LintError} listing every problem found
 */
export async function loadFixtures(rootDir, { categories }) {
  const problems = [];
  /** @type {Fixture[]} */
  const fixtures = [];
  const seen = new Map();

  for (const category of categories) {
    const dir = path.join(rootDir, category, 'fixtures');
    const relDir = path.join(category, 'fixtures');
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err) {
      problems.push(`${relDir}: cannot read directory (${err.code ?? err.message})`);
      continue;
    }
    const files = entries
      .filter((e) => e.isFile() && e.name.endsWith('.json'))
      .map((e) => e.name)
      .sort();

    for (const name of files) {
      const rel = path.join(relDir, name);
      let obj;
      try {
        obj = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      } catch (err) {
        problems.push(`${rel}: not valid JSON (${err.message})`);
        continue;
      }
      const found = lintFixture(obj, rel);
      problems.push(...found);
      if (found.length > 0) continue;

      if (seen.has(obj.test_id)) {
        problems.push(`${rel}: duplicate test_id "${obj.test_id}" (also in ${seen.get(obj.test_id)})`);
        continue;
      }
      seen.set(obj.test_id, rel);
      Object.defineProperty(obj, 'file', { value: rel, enumerable: false });
      fixtures.push(obj);
    }
  }

  if (problems.length > 0) throw new LintError(problems);
  return fixtures.sort((a, b) => (a.test_id < b.test_id ? -1 : a.test_id > b.test_id ? 1 : 0));
}

/**
 * Reads and checks a target profile.
 * @param {string} filePath
 * @returns {Promise<Target>}
 * @throws {LintError} on a missing file, bad JSON, a missing required key,
 *   an unknown capability, or a role a declared capability needs but `roles` lacks
 */
export async function loadTarget(filePath) {
  const file = path.basename(filePath);
  let obj;
  try {
    obj = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (err) {
    throw new LintError([`${file}: cannot read target (${err.message})`]);
  }
  const problems = [];
  const problem = (text) => problems.push(`${file}: ${text}`);

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new LintError([`${file}: target must be a JSON object`]);
  }
  const missing = TARGET_REQUIRED_KEYS.filter((k) => !(k in obj));
  if (missing.length > 0) problem(`missing required key(s): ${missing.join(', ')}`);

  const capabilities = Array.isArray(obj.capabilities) ? obj.capabilities : [];
  if ('capabilities' in obj && !Array.isArray(obj.capabilities)) problem('capabilities must be an array');
  const roles = obj.roles && typeof obj.roles === 'object' && !Array.isArray(obj.roles) ? obj.roles : {};
  if ('roles' in obj && roles !== obj.roles) problem('roles must be an object');

  // One problem per missing role, naming every capability that needs it.
  const needed = new Map();
  for (const cap of capabilities) {
    if (!(cap in CAPABILITY_ROLES)) {
      problem(`unknown capability "${cap}" (known: ${Object.keys(CAPABILITY_ROLES).join(', ')})`);
      continue;
    }
    for (const role of CAPABILITY_ROLES[cap]) {
      if (typeof roles[role] !== 'string') needed.set(role, [...(needed.get(role) ?? []), cap]);
    }
  }
  for (const [role, caps] of needed) {
    problem(`roles.${role} is missing but capability ${caps.map((c) => `"${c}"`).join(', ')} needs it`);
  }
  for (const role of ALWAYS_ROLES) {
    if (typeof roles[role] !== 'string') problem(`roles.${role} is required for every target`);
  }

  if (problems.length > 0) throw new LintError(problems);
  return obj;
}
