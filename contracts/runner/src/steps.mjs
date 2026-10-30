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

// Step kinds. Each kind takes a step and the fixture context and returns the
// response it produced (if any), redacted evidence, and the expectation result.
// `wait_state` and `sse_read` are added in a later task.

import { buildRequest, redactUrl } from './http.mjs';
import { check, jsonPath } from './assert.mjs';

/**
 * @typedef {object} StepContext
 * @property {import('./load.mjs').Target} target
 * @property {Record<string, unknown>} vars  `roles`, `uniq` and captured names; mutated by captures
 * @property {string | undefined} apiKey
 * @property {typeof fetch} fetch
 * @property {{now: () => number, sleep: (ms: number) => Promise<void>}} clock
 * @property {(line: string) => void} log
 * @property {Map<string, StepResponse>} responses  responses by step id, for `capture` steps
 */

/**
 * @typedef {object} StepResponse
 * @property {number} status
 * @property {Headers} headers
 * @property {unknown} json  parsed body, or undefined when not JSON
 * @property {string} text
 */

/**
 * @typedef {object} StepResult
 * @property {StepResponse} [response]
 * @property {object} [evidence]  `{method, path, status, code}` with secrets masked
 * @property {import('./assert.mjs').CheckResult} check
 */

/**
 * Copies values out of a response into vars. One match gives the value, many
 * give an array, none is an error.
 */
function applyCapture(capture, response, vars) {
  for (const [name, path] of Object.entries(capture ?? {})) {
    const found = jsonPath(response.json, path);
    if (found.length === 0) throw new Error(`capture ${name}: nothing at ${path}`);
    vars[name] = found.length === 1 ? found[0] : found;
  }
}

/** @type {(step: object, ctx: StepContext) => Promise<StepResult>} */
async function request(step, ctx) {
  const { url, init, path } = buildRequest(ctx.target, step, ctx.vars, ctx.apiKey);
  const method = init.method;
  let res;
  try {
    res = await ctx.fetch(url, init);
  } catch (err) {
    throw new Error(`request ${method} ${redactUrl(path)} failed: ${err?.message ?? err}`);
  }
  const text = await res.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  const response = { status: res.status, headers: res.headers, json, text };
  if (step.id) ctx.responses.set(step.id, response);
  applyCapture(step.capture, response, ctx.vars);
  const code = json && typeof json === 'object' && json.error && typeof json.error === 'object' ? (json.error.code ?? null) : null;
  return {
    response,
    evidence: { method, path: redactUrl(path), status: res.status, code },
    check: check(step.expect, response),
  };
}

/** @type {(step: object, ctx: StepContext) => Promise<StepResult>} */
async function capture(step, ctx) {
  const response = ctx.responses.get(step.from);
  if (!response) throw new Error(`capture step refers to unknown step id "${step.from}"`);
  applyCapture(step.capture, response, ctx.vars);
  return { check: { outcome: 'pass', reason: '' } };
}

/** @type {Record<string, (step: object, ctx: StepContext) => Promise<StepResult>>} */
export const STEP_KINDS = { request, capture };

/**
 * Runs one step.
 * @param {object} step
 * @param {StepContext} ctx
 * @returns {Promise<StepResult>}
 * @throws {Error} on an unknown kind, a failed fetch, a bad placeholder or an empty capture
 */
export async function runStep(step, ctx) {
  const run = STEP_KINDS[step?.kind];
  if (!run) throw new Error(`unknown step kind "${step?.kind}"`);
  return run(step, ctx);
}
