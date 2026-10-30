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

// Runs fixtures against a target and produces the report. Owns the skip
// rules, the setup/steps/teardown ordering, level mapping and totals.

import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

import { runStep } from './steps.mjs';

const RUNNER_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

/**
 * @typedef {{now: () => number, sleep: (ms: number) => Promise<void>}} Clock
 */

/**
 * @typedef {object} Result
 * @property {string} test_id
 * @property {string} level
 * @property {'pass' | 'fail' | 'note' | 'skip'} outcome
 * @property {string} reason
 * @property {object[]} evidence  one `{method, path, status, code}` per request made
 */

/**
 * @typedef {object} Report
 * @property {string} target
 * @property {string} runner_version
 * @property {string} fixtures_commit
 * @property {string} started_at
 * @property {{pass: number, fail: number, note: number, skip: number}} totals
 * @property {Result[]} results
 */

/** @type {Clock} */
export const systemClock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

/** Returns the first `requires` entry the target does not satisfy, or undefined. */
function missingRequirement(fixture, target) {
  const have = new Set([...(target.capabilities ?? []), ...(target.extensions ?? []), ...Object.keys(target.roles ?? {})]);
  return (fixture.requires ?? []).find((entry) => !have.has(entry));
}

/**
 * Runs a phase (setup, steps or teardown). Returns the first failure as
 * `{reason, tolerated}` or undefined. A thrown error or a `fail` check stops
 * the phase; a `note` is collected and the phase goes on. In steps and
 * teardown a `tolerate: true` step's failure is ignored. In setup it still
 * stops the phase (the fixture cannot be set up) but is flagged `tolerated`
 * so the caller can skip instead of fail. Setup notes are not collected:
 * only the checked steps grade the fixture.
 */
async function runPhase(steps, ctx, acc, { setup = false } = {}) {
  for (const step of steps ?? []) {
    let failure;
    try {
      const result = await runStep(step, ctx);
      if (result.evidence) acc.evidence.push(result.evidence);
      if (result.check.outcome === 'fail') failure = result.check.reason;
      else if (result.check.outcome === 'note' && !setup) acc.notes.push(result.check.reason);
    } catch (err) {
      failure = err?.message ?? String(err);
    }
    if (failure === undefined) continue;
    const tolerated = step?.tolerate === true;
    if (tolerated && !setup) continue;
    return { reason: failure, tolerated };
  }
  return undefined;
}

/** @returns {Promise<Result>} */
async function runFixture(fixture, ctx) {
  const { target } = ctx;
  const base = { test_id: fixture.test_id, level: fixture.level, evidence: [] };

  const missing = missingRequirement(fixture, target);
  if (missing !== undefined) {
    return { ...base, outcome: 'skip', reason: `target does not provide "${missing}"` };
  }
  if ((fixture.tags ?? []).includes('live') && !target.live_vendor) {
    return { ...base, outcome: 'skip', reason: 'live fixture; target has no live_vendor' };
  }

  const acc = { evidence: base.evidence, notes: [] };
  let outcome = 'pass';
  let reason = '';

  const setupFailure = await runPhase(fixture.setup, ctx, acc, { setup: true });
  if (setupFailure) {
    outcome = setupFailure.tolerated && fixture.level !== 'MUST' ? 'skip' : 'fail';
    reason = `setup: ${setupFailure.reason}`;
  } else {
    const failure = await runPhase(fixture.steps, ctx, acc);
    if (failure) {
      outcome = 'fail';
      reason = failure.reason;
    }
  }

  const teardownFailure = await runPhase(fixture.teardown, ctx, acc);
  if (teardownFailure && outcome !== 'fail') {
    outcome = 'fail';
    reason = `teardown: ${teardownFailure.reason}`;
  }

  if (outcome === 'pass' && acc.notes.length > 0) {
    outcome = 'note';
    reason = acc.notes.join('; ');
  }

  if (outcome === 'fail') {
    const known = target.known_failures?.[fixture.test_id];
    if (known !== undefined) {
      outcome = 'note';
      reason = `known: ${known} (${reason})`;
    } else if (fixture.level === 'SHOULD') {
      outcome = 'note';
      reason = `SHOULD not met: ${reason}`;
    }
  }

  return { ...base, outcome, reason };
}

/**
 * Runs every fixture, in order, against one target.
 * @param {object} options
 * @param {object[]} options.fixtures  linted fixtures from load.mjs
 * @param {import('./load.mjs').Target} options.target
 * @param {string} [options.apiKey]
 * @param {typeof fetch} [options.fetch]  defaults to the global fetch
 * @param {Clock} [options.clock]
 * @param {(line: string) => void} [options.log]
 * @param {string} [options.fixturesCommit]
 * @param {string} [options.auditFile]  audit trail path; carried on the context for audit-trail step kinds (later task)
 * @returns {Promise<Report>}
 */
export async function runSuite({ fixtures, target, apiKey, fetch = globalThis.fetch, clock = systemClock, log = () => {}, fixturesCommit, auditFile }) {
  const runToken = randomBytes(4).toString('hex');
  const report = {
    target: target.name,
    runner_version: RUNNER_VERSION,
    fixtures_commit: fixturesCommit ?? 'unknown',
    started_at: new Date(clock.now()).toISOString(),
    totals: { pass: 0, fail: 0, note: 0, skip: 0 },
    results: [],
  };

  let counter = 0;
  for (const fixture of fixtures) {
    counter += 1;
    const ctx = {
      target,
      vars: { roles: target.roles ?? {}, uniq: `${runToken}-${counter}` },
      apiKey,
      fetch,
      clock,
      log,
      auditFile,
      responses: new Map(),
    };
    const result = await runFixture(fixture, ctx);
    report.results.push(result);
    report.totals[result.outcome] += 1;
    log(`${result.outcome.padEnd(4)} ${result.test_id} ${fixture.level}${result.reason ? ` - ${result.reason}` : ''}`);
  }
  return report;
}

/**
 * 1 when any MUST fixture failed, otherwise 0.
 * @param {Pick<Report, 'results'>} report
 * @returns {0 | 1}
 */
export function exitCode(report) {
  return report.results.some((r) => r.level === 'MUST' && r.outcome === 'fail') ? 1 : 0;
}
