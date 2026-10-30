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
// Bounded waits (`wait_state`, `sse_read`) default to the target's `timeouts`
// (`wait_s`, `sse_s`; both 15 s when unset) and a step's `timeout_s` overrides
// them; every wait goes through `ctx.clock`.

import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';

import { buildRequest, redactUrl, template } from './http.mjs';
import { check, jsonPath } from './assert.mjs';
import { readEvents } from './sse.mjs';
import { parseTrail, verifyChain } from './audit.mjs';

const DEFAULT_TIMEOUT_S = 15;
const BACKOFF_MS = [250, 500, 1000, 2000];

/**
 * @typedef {object} StepContext
 * @property {import('./load.mjs').Target} target
 * @property {Record<string, unknown>} vars  `roles`, `uniq` and captured names; mutated by captures
 * @property {string | undefined} apiKey
 * @property {typeof fetch} fetch
 * @property {import('./sse.mjs').Clock} clock  every wait goes through this; `sleep` honours an AbortSignal
 * @property {(line: string) => void} log
 * @property {Map<string, StepResponse>} responses  responses by step id, for `capture` and `audit_verify` steps
 * @property {string} [contractsRoot]  directory a request step's `trail` path resolves against
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

/**
 * A request step with `trail: "<path>"` posts a committed NDJSON trail as
 * `{events: [...]}`. The path is relative to the contracts root (a fixture
 * path such as "audit-trail/fixtures/trails/good.jsonl"); the file must be
 * inside that root. A missing or unparseable trail throws.
 */
function withTrail(step, ctx) {
  if (step.trail === undefined) return step;
  if (typeof step.trail !== 'string' || step.trail === '') throw new Error('request step: trail must be a non-empty path');
  const root = resolve(ctx.contractsRoot ?? '.');
  const file = resolve(root, step.trail);
  if (!file.startsWith(root + sep)) throw new Error(`request step: trail "${step.trail}" is outside the contracts root`);
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch (err) {
    throw new Error(`request step: trail "${step.trail}" could not be read: ${err?.message ?? err}`);
  }
  return { ...step, body: { ...(step.body ?? {}), events: parseTrail(text) } };
}

/** @type {(step: object, ctx: StepContext) => Promise<StepResult>} */
async function request(rawStep, ctx) {
  const step = withTrail(rawStep, ctx);
  const { url, init, path } = buildRequest(ctx.target, step, ctx.vars, ctx.apiKey);
  const method = init.method;
  let res;
  try {
    res = await ctx.fetch(url, init);
  } catch (err) {
    throw new Error(`request ${method} ${redactUrl(path)} failed: ${err?.message ?? err}`);
  }
  return finish(step, ctx, await readBody(res), method, path);
}

/** @type {(step: object, ctx: StepContext) => Promise<StepResult>} */
async function capture(step, ctx) {
  const response = ctx.responses.get(step.from);
  if (!response) throw new Error(`capture step refers to unknown step id "${step.from}"`);
  applyCapture(step.capture, response, ctx.vars);
  return { check: { outcome: 'pass', reason: '' } };
}

/** Reads a response body as text and parses it as JSON when it is JSON. */
async function readBody(res) {
  const text = await res.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, json, text };
}

function errorCode(json) {
  return json && typeof json === 'object' && json.error && typeof json.error === 'object' ? (json.error.code ?? null) : null;
}

/**
 * Finishes a step that produced a response: id, capture, evidence, expect.
 * Captures are applied first so `expect` values may name them (`"{{iid}}"`);
 * `check` redacts any `token=` value a templated reason would otherwise quote.
 */
function finish(step, ctx, response, method, path) {
  if (step.id) ctx.responses.set(step.id, response);
  applyCapture(step.capture, response, ctx.vars);
  return {
    response,
    evidence: { method, path: redactUrl(path), status: response.status, code: errorCode(response.json) },
    check: check(step.expect === undefined ? undefined : template(step.expect, ctx.vars), response),
  };
}

/** The templated instance id of a wait_state / sse_read step. */
function instanceId(step, ctx) {
  if (typeof step.instance !== 'string' || step.instance === '') throw new Error(`${step.kind} step needs an instance`);
  return String(template(step.instance, ctx.vars));
}

/** A GET of `path` on the target, honouring the step's auth / probe flags. */
function get(step, ctx, path, headers = {}) {
  const { url, init } = buildRequest(ctx.target, { ...step, method: 'GET', path, body: undefined, headers: { ...(step.headers ?? {}), ...headers } }, ctx.vars, ctx.apiKey);
  return { url, init };
}

/** `data.state.current` of an instance body, or `data.state` when it is a bare string. */
function currentState(json) {
  const state = json?.data?.state;
  if (typeof state === 'string') return state;
  return typeof state?.current === 'string' ? state.current : null;
}

/**
 * Polls GET /instances/{id} until `state.current` is one of `states` or the
 * bound passes. Backoff 250 ms doubling to 2 s, clipped to the deadline.
 * A timeout is a failed check naming the last state seen.
 * @type {(step: object, ctx: StepContext) => Promise<StepResult>}
 */
async function waitState(step, ctx) {
  if (!Array.isArray(step.states) || step.states.length === 0) throw new Error('wait_state step needs a non-empty states list');
  const id = instanceId(step, ctx);
  const path = `/instances/${id}`;
  const seconds = step.timeout_s ?? ctx.target.timeouts?.wait_s ?? DEFAULT_TIMEOUT_S;
  const timeoutMs = seconds * 1000;
  const started = ctx.clock.now();
  const { url, init } = get(step, ctx, path);

  let lastSeen = 'nothing';
  let response;
  for (let attempt = 0; ; attempt += 1) {
    let res;
    try {
      res = await ctx.fetch(url, init);
    } catch (err) {
      throw new Error(`wait_state GET ${redactUrl(path)} failed: ${err?.message ?? err}`);
    }
    response = await readBody(res);
    const current = res.status === 200 ? currentState(response.json) : null;
    if (current !== null && step.states.includes(current)) return finish(step, ctx, response, 'GET', path);
    lastSeen = current ?? `HTTP ${res.status}${errorCode(response.json) ? ` ${errorCode(response.json)}` : ''}`;

    const remaining = timeoutMs - (ctx.clock.now() - started);
    if (remaining <= 0) break;
    await ctx.clock.sleep(Math.min(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)], remaining));
  }
  return {
    response,
    evidence: { method: 'GET', path: redactUrl(path), status: response.status, code: errorCode(response.json) },
    check: { outcome: 'fail', reason: `wait_state: ${redactUrl(path)} did not reach ${step.states.join('|')} within ${seconds}s; last seen ${lastSeen}` },
  };
}

/**
 * Opens GET /instances/{id}/events and reads events until `max`,
 * `until_state`, the bound or the server closing. The step's response is a
 * synthetic JSON body `{events, ended}` so `expect` and `capture` work on it;
 * `capture_events` names a var that receives the events array. A non-200
 * response is read and graded like a request. The body is aborted when done.
 * @type {(step: object, ctx: StepContext) => Promise<StepResult>}
 */
async function sseRead(step, ctx) {
  const id = instanceId(step, ctx);
  const path = `/instances/${id}/events`;
  const seconds = step.timeout_s ?? ctx.target.timeouts?.sse_s ?? DEFAULT_TIMEOUT_S;
  const headers = { accept: 'text/event-stream' };
  if (step.last_event_id !== undefined) headers['last-event-id'] = String(template(step.last_event_id, ctx.vars));
  const { url, init } = get(step, ctx, path, headers);
  const controller = new AbortController();
  init.signal = controller.signal;

  let res;
  try {
    res = await ctx.fetch(url, init);
  } catch (err) {
    throw new Error(`sse_read GET ${redactUrl(path)} failed: ${err?.message ?? err}`);
  }
  let response;
  try {
    if (res.status !== 200) {
      response = await readBody(res);
    } else {
      const result = await readEvents(res, {
        max: step.max ?? Infinity,
        untilState: step.until_state,
        timeoutMs: seconds * 1000,
        signal: controller.signal,
        clock: ctx.clock,
      });
      response = { status: res.status, headers: res.headers, json: result, text: '' };
      if (typeof step.capture_events === 'string') ctx.vars[step.capture_events] = result.events;
    }
  } finally {
    controller.abort();
  }
  return finish(step, ctx, response, 'GET', path);
}

/**
 * Runs the offline verifier (audit.mjs) over the NDJSON body of an earlier
 * request step named by `from`, as `--audit-file` would over a saved file.
 * The result is a synthetic response `{issues, events}` so `expect.json`
 * can pin `$.issues`. An empty or unparseable export, or an event that
 * cannot be canonicalized, throws and so fails the fixture (the audit-trail
 * contract's "unreadable" outcome). No request is made.
 * @type {(step: object, ctx: StepContext) => Promise<StepResult>}
 */
async function auditVerify(step, ctx) {
  const exported = ctx.responses.get(step.from);
  if (!exported) throw new Error(`audit_verify step refers to unknown step id "${step.from}"`);
  const events = parseTrail(exported.text);
  if (events.length === 0) throw new Error(`audit_verify: step "${step.from}" exported no events`);
  const issues = verifyChain(events);
  const json = { issues, events: events.length };
  const response = { status: 200, headers: new Headers(), json, text: JSON.stringify(json) };
  return finish(step, ctx, response, 'VERIFY', `offline:${step.from}`);
}

/** @type {Record<string, (step: object, ctx: StepContext) => Promise<StepResult>>} */
export const STEP_KINDS = { request, capture, wait_state: waitState, sse_read: sseRead, audit_verify: auditVerify };

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
