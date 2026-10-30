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

// Builds HTTP requests from fixture steps: placeholder templating, URL
// joining, JSON bodies, the target's auth header, and redaction for reports.

const PLACEHOLDER = /\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g;
const WHOLE_PLACEHOLDER = /^\{\{\s*([A-Za-z0-9_.]+)\s*\}\}$/;
const SECRET_HEADERS = new Set(['x-api-key', 'authorization']);
const TOKEN_QUERY = /([?&]token=)[^&\s]*/gi;
const DEFAULT_AUTH_HEADER = 'X-API-Key';

/**
 * Looks up a dotted name (`roles.observable_action`, `iid`) in vars.
 * @throws {Error} when any part of the path is missing
 */
function lookup(name, vars) {
  let value = vars;
  for (const part of name.split('.')) {
    if (value === null || typeof value !== 'object' || !(part in value)) {
      throw new Error(`unknown placeholder {{${name}}}`);
    }
    value = value[part];
  }
  return value;
}

/**
 * Replaces `{{name}}` placeholders in a string, or in every string inside an
 * object or array. A string that is exactly one placeholder keeps the value's
 * type, so a captured number stays a number.
 * @template T
 * @param {T} value
 * @param {Record<string, unknown>} vars  includes `roles` (the target's map) and `uniq`
 * @returns {T}
 */
export function template(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(WHOLE_PLACEHOLDER);
    if (whole) return lookup(whole[1], vars);
    return value.replace(PLACEHOLDER, (_, name) => String(lookup(name, vars)));
  }
  if (Array.isArray(value)) return value.map((v) => template(v, vars));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, template(v, vars)]));
  }
  return value;
}

/**
 * Builds the `fetch` arguments for a request step.
 * @param {import('./load.mjs').Target} target
 * @param {object} step  a `kind: "request"` step
 * @param {Record<string, unknown>} vars
 * @param {string | undefined} apiKey
 * @returns {{url: string, init: RequestInit, path: string}}  `path` is the templated path, for evidence
 * @throws {Error} on an unknown placeholder or a probe step without `probe_url`
 */
export function buildRequest(target, step, vars, apiKey) {
  const base = step.probe ? target.probe_url : target.base_url;
  if (step.probe && typeof base !== 'string') {
    throw new Error('step has probe: true but the target has no probe_url');
  }
  const path = template(step.path ?? '/', vars);
  const url = base.replace(/\/+$/, '') + path;
  const method = (step.method ?? 'GET').toUpperCase();

  const headers = new Headers({ accept: 'application/json' });
  let body;
  if (step.body !== undefined) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(template(step.body, vars));
  }
  const auth = target.auth ?? { mode: 'none' };
  if (auth.mode !== 'none' && apiKey && step.auth !== false) {
    const scheme = typeof auth.scheme === 'string' && auth.scheme !== '' ? `${auth.scheme} ` : '';
    headers.set(auth.header ?? DEFAULT_AUTH_HEADER, `${scheme}${apiKey}`);
  }
  for (const [name, value] of Object.entries(template(step.headers ?? {}, vars))) {
    headers.set(name, String(value));
  }

  const init = { method, headers };
  if (body !== undefined) init.body = body;
  return { url, init, path };
}

/**
 * Copies headers with X-API-Key and Authorization values, and any `token=`
 * query value inside a header, replaced by `***`.
 * @param {Headers | Record<string, string>} headers
 * @returns {Record<string, string>}
 */
export function redact(headers) {
  const entries = typeof headers?.entries === 'function' ? [...headers.entries()] : Object.entries(headers ?? {});
  const out = {};
  for (const [name, value] of entries) {
    out[name] = SECRET_HEADERS.has(name.toLowerCase()) ? '***' : redactUrl(String(value));
  }
  return out;
}

/**
 * Masks the value of a `token` query parameter in a URL or path.
 * @param {string} url
 * @returns {string}
 */
export function redactUrl(url) {
  return url.replace(TOKEN_QUERY, '$1***');
}
