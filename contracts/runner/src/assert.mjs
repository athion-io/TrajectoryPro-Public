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

// The expectation engine. `check` grades one response against a step's
// `expect` block and returns pass, note or fail with a plain-English reason.

import { isDeepStrictEqual } from 'node:util';
import { redactUrl, redactValue } from './http.mjs';

/**
 * @typedef {object} Response
 * @property {number} status
 * @property {Headers | Record<string, string>} headers
 * @property {unknown} [json]  the parsed body, or undefined when it was not JSON
 */

/**
 * @typedef {{outcome: 'pass' | 'fail' | 'note', reason: string}} CheckResult
 */

const JSON_OPERATORS = ['present', 'absent', 'equals', 'not_equals', 'type', 'in', 'matches', 'length_max'];
const PATH_TOKEN = /\.([A-Za-z0-9_-]+)|\[(-?\d+|\*)\]/y;

/**
 * Evaluates a small JSONPath subset: `$`, `.key`, `[n]`, `[-n]`, `[*]`.
 * `[-n]` counts from the end of an array (`[-1]` is the last element).
 * @param {unknown} obj
 * @param {string} path
 * @returns {unknown[]} every value the path reaches; empty when nothing matches
 * @throws {Error} when the path uses syntax outside the subset
 */
export function jsonPath(obj, path) {
  if (typeof path !== 'string' || !path.startsWith('$')) {
    throw new Error(`json path "${path}" must start with $`);
  }
  let current = [obj];
  let index = 1;
  while (index < path.length) {
    PATH_TOKEN.lastIndex = index;
    const m = PATH_TOKEN.exec(path);
    if (!m) throw new Error(`json path "${path}" is not supported at position ${index} (use $, .key, [n], [-n], [*])`);
    index = PATH_TOKEN.lastIndex;
    const next = [];
    for (const value of current) {
      if (m[1] !== undefined) {
        if (value !== null && typeof value === 'object' && !Array.isArray(value) && m[1] in value) next.push(value[m[1]]);
      } else if (m[2] === '*') {
        if (Array.isArray(value)) next.push(...value);
      } else if (Array.isArray(value)) {
        const n = Number(m[2]);
        const i = n < 0 ? value.length + n : n;
        if (i >= 0 && i < value.length) next.push(value[i]);
      }
    }
    current = next;
  }
  return current;
}

function show(value) {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 80 ? `${text.slice(0, 77)}...` : text;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function hasType(value, type) {
  if (type === 'integer') return Number.isInteger(value);
  return typeOf(value) === type;
}

/** @returns {CheckResult} */
function checkStatus(expect, status) {
  if (typeof expect === 'number') {
    return status === expect ? pass() : fail(`status ${status}, expected ${expect}`);
  }
  const oneOf = Array.isArray(expect.one_of) ? expect.one_of : [];
  if (oneOf.includes(status)) return pass();
  const noteIf = expect.note_if ?? {};
  const noted =
    (Array.isArray(noteIf.one_of) && noteIf.one_of.includes(status)) ||
    (Array.isArray(noteIf.range) && status >= noteIf.range[0] && status <= noteIf.range[1]);
  if (noted) return note(`status ${status} is an allowed variance (expected ${oneOf.join(' or ')})`);
  return fail(`status ${status}, expected ${oneOf.join(' or ')}`);
}

/**
 * Narrows the values a json item reaches. `where: {path, equals}` keeps only
 * the elements whose relative `path` (from the element, so it starts with `$`)
 * yields exactly `equals`; `select` then replaces each kept element by what
 * its relative path reaches. Both are optional and apply before the operators.
 */
function selectMatches(item, matches) {
  let values = matches;
  if (item.where) {
    if (typeof item.where.path !== 'string' || !('equals' in item.where)) {
      throw new Error(`json check at ${item.path} has a where without path and equals`);
    }
    values = values.filter((v) => {
      const found = jsonPath(v, item.where.path);
      return found.length === 1 && isDeepStrictEqual(found[0], item.where.equals);
    });
  }
  if (item.select !== undefined) values = values.flatMap((v) => jsonPath(v, item.select));
  return values;
}

function describePath(item) {
  let text = item.path;
  if (item.where) text += `[where ${item.where.path} = ${show(item.where.equals)}]`;
  if (item.select !== undefined) text += item.select.slice(1);
  return text;
}

/**
 * Grades one json item. `when_status: [codes]` limits the item to responses
 * with one of those statuses; for any other status it is a pass, so a fixture
 * can pin a body detail on its MUST status while a `note_if` status stays free.
 * @returns {CheckResult}
 */
function checkJsonItem(item, json, status) {
  const ops = JSON_OPERATORS.filter((op) => op in item);
  if (ops.length === 0) throw new Error(`json check at ${item.path} has no operator (${JSON_OPERATORS.join(', ')})`);
  if ('when_status' in item) {
    if (!Array.isArray(item.when_status)) throw new Error(`json check at ${item.path} has a when_status that is not an array`);
    if (!item.when_status.includes(status)) return pass();
  }
  if (json === undefined) return fail(`${item.path}: body is not JSON`);
  const matches = selectMatches(item, jsonPath(json, item.path));
  const at = (text) => fail(`${describePath(item)}: ${text}`);

  for (const op of ops) {
    const want = item[op];
    if (op === 'present' || op === 'absent') {
      const wantPresent = op === 'present' ? want !== false : want === false;
      if (wantPresent && matches.length === 0) return at('nothing at path');
      if (!wantPresent && matches.length > 0) return at(`present (${show(matches[0])}) but expected absent`);
      continue;
    }
    if (matches.length === 0) return at('nothing at path');
    for (const value of matches) {
      switch (op) {
        case 'equals':
          if (!isDeepStrictEqual(value, want)) return at(`is ${show(value)}, expected ${show(want)}`);
          break;
        case 'not_equals':
          if (isDeepStrictEqual(value, want)) return at(`is ${show(value)}, expected a different value`);
          break;
        case 'type':
          if (!hasType(value, want)) return at(`is ${typeOf(value)} (${show(value)}), expected ${want}`);
          break;
        case 'in':
          if (!want.some((w) => isDeepStrictEqual(value, w))) return at(`is ${show(value)}, expected one of ${show(want)}`);
          break;
        case 'matches':
          if (typeof value !== 'string' || !new RegExp(want).test(value)) return at(`is ${show(value)}, expected to match /${want}/`);
          break;
        case 'length_max':
          if ((typeof value !== 'string' && !Array.isArray(value)) || value.length > want) {
            return at(`has length ${value?.length ?? 'n/a'} (${show(value)}), expected at most ${want}`);
          }
          break;
        default:
          break;
      }
    }
  }
  return pass();
}

function headerValue(headers, name) {
  if (typeof headers?.get === 'function') return headers.get(name);
  const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? null : headers[key];
}

/** @returns {CheckResult} */
function checkHeader(name, rule, headers) {
  const value = headerValue(headers, name);
  // Reasons land in the report, so the quoted value is masked when secret.
  const shown = value === null ? null : show(redactValue(name, value));
  if ('present' in rule) {
    if (rule.present !== false && value === null) return fail(`header ${name} is missing`);
    if (rule.present === false && value !== null) return fail(`header ${name} is present, expected absent`);
  }
  if ('equals' in rule) {
    if (value === null) return fail(`header ${name} is missing`);
    if (value !== rule.equals) return fail(`header ${name} is ${shown}, expected ${show(rule.equals)}`);
  }
  if ('contains_token' in rule) {
    if (value === null) return fail(`header ${name} is missing`);
    const tokens = value.split(',').map((t) => t.trim().toLowerCase());
    if (!tokens.includes(String(rule.contains_token).toLowerCase())) {
      return fail(`header ${name} is ${shown}, expected to contain ${rule.contains_token}`);
    }
  }
  return pass();
}

const pass = () => ({ outcome: 'pass', reason: '' });
const note = (reason) => ({ outcome: 'note', reason });
const fail = (reason) => ({ outcome: 'fail', reason });

/**
 * Grades a response. A fail anywhere gives `fail`; otherwise a note anywhere
 * gives `note`; otherwise `pass`. The reason lists every fail (or every note),
 * with any `token=` query value it quotes masked, since reasons are reported.
 * @param {object | undefined} expect  `{status?, json?, headers?}`
 * @param {Response} response
 * @returns {CheckResult}
 */
export function check(expect, response) {
  const results = [];
  if (!expect) return pass();
  if ('status' in expect) results.push(checkStatus(expect.status, response.status));
  for (const item of expect.json ?? []) results.push(checkJsonItem(item, response.json, response.status));
  for (const [name, rule] of Object.entries(expect.headers ?? {})) results.push(checkHeader(name, rule, response.headers));

  const fails = results.filter((r) => r.outcome === 'fail');
  if (fails.length > 0) return fail(redactUrl(fails.map((r) => r.reason).join('; ')));
  const notes = results.filter((r) => r.outcome === 'note');
  if (notes.length > 0) return note(redactUrl(notes.map((r) => r.reason).join('; ')));
  return pass();
}
