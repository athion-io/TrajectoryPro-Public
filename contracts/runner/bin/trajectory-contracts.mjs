#!/usr/bin/env node
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

// Command line entry point. Loads fixtures and a target, runs the suite and
// writes the report. Exit codes: 0 no MUST failed, 1 a MUST failed,
// 2 usage, lint or target error. `--audit-file` instead verifies one local
// trail offline (0 clean, 1 issues, 2 unreadable). The API key comes from CONTRACTS_API_KEY;
// forwarded-identity user tokens from CONTRACTS_USER_TOKEN and
// CONTRACTS_UNGRANTED_USER_TOKEN. Secrets are never read from a target file.

import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { CATEGORIES, LintError, loadFixtures, loadTarget } from '../src/load.mjs';
import { exitCode, runSuite } from '../src/run.mjs';
import { verifyTrailFile } from '../src/audit.mjs';

const USAGE = `Usage: trajectory-contracts --target <file> [options]
       trajectory-contracts --audit-file <trail.jsonl>

  --target <file>        target profile (required unless --audit-file)
  --suite <a,b>          categories to run (default: every category with fixtures)
  --only <id[,id]>       run only these test_ids
  --report <out.json>    write the JSON report here
  --audit-file <file>    verify a local audit trail (NDJSON) offline, no network;
                         exit 0 clean, 1 issues found, 2 unreadable or uncanonicalizable
  --help

Environment:
  CONTRACTS_API_KEY      API key sent as the target's auth header
  CONTRACTS_USER_TOKEN   forwarded-identity user token with the grant ({{user_token}})
  CONTRACTS_UNGRANTED_USER_TOKEN
                         valid user token without the grant ({{ungranted_user_token}});
                         fixtures that need a token the runner was not given skip

Exit codes: 0 no MUST failed, 1 a MUST failed, 2 usage, lint or target error.`;

const CONTRACTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function usageError(message) {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  return 2;
}

function fixturesCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CONTRACTS_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return 'unknown';
  }
}

/**
 * `--audit-file`: the audit-trail contract's offline check (C-AUD-3..6) over
 * a saved NDJSON trail. Prints one line per issue (index, id, kind) and never
 * a payload value. Exit 0 clean, 1 issues, 2 unreadable or uncanonicalizable.
 */
function verifyOffline(file) {
  const result = verifyTrailFile(path.resolve(file));
  if (result.code === 2) {
    process.stderr.write(`audit trail ${file}: ${result.error}\n`);
    return 2;
  }
  for (const issue of result.issues) {
    process.stdout.write(`index ${issue.index} id ${JSON.stringify(issue.id)}: ${issue.issue}\n`);
  }
  process.stdout.write(`${file}: ${result.events} events, ${result.issues.length} issue${result.issues.length === 1 ? '' : 's'}\n`);
  return result.code;
}

async function main(argv) {
  let args;
  try {
    ({ values: args } = parseArgs({
      args: argv,
      options: {
        target: { type: 'string' },
        suite: { type: 'string' },
        only: { type: 'string' },
        report: { type: 'string' },
        'audit-file': { type: 'string' },
        help: { type: 'boolean' },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    return usageError(err.message);
  }
  if (args.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  if (args['audit-file']) {
    if (args.target || args.suite || args.only || args.report) {
      return usageError('--audit-file verifies one local trail offline; it takes no --target, --suite, --only or --report');
    }
    return verifyOffline(args['audit-file']);
  }
  if (!args.target) return usageError('--target is required');

  let categories;
  if (args.suite) {
    categories = args.suite.split(',').map((s) => s.trim()).filter(Boolean);
    const unknown = categories.filter((c) => !CATEGORIES.includes(c));
    if (unknown.length > 0) return usageError(`unknown suite: ${unknown.join(', ')} (known: ${CATEGORIES.join(', ')})`);
  } else {
    categories = CATEGORIES.filter((c) => existsSync(path.join(CONTRACTS_ROOT, c, 'fixtures')));
  }

  let target;
  let fixtures;
  try {
    target = await loadTarget(path.resolve(args.target));
    fixtures = await loadFixtures(CONTRACTS_ROOT, { categories });
  } catch (err) {
    if (err instanceof LintError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    throw err;
  }

  if (args.only) {
    const wanted = new Set(args.only.split(',').map((s) => s.trim()).filter(Boolean));
    fixtures = fixtures.filter((f) => wanted.has(f.test_id));
    const found = new Set(fixtures.map((f) => f.test_id));
    const missing = [...wanted].filter((id) => !found.has(id));
    if (missing.length > 0) return usageError(`--only: no fixture with test_id ${missing.join(', ')}`);
  }

  const apiKey = process.env.CONTRACTS_API_KEY;
  if (target.auth?.mode === 'required' && !apiKey) {
    return usageError(`target "${target.name}" requires an API key; set CONTRACTS_API_KEY`);
  }

  const report = await runSuite({
    fixtures,
    target,
    apiKey,
    userTokens: {
      user_token: process.env.CONTRACTS_USER_TOKEN,
      ungranted_user_token: process.env.CONTRACTS_UNGRANTED_USER_TOKEN,
    },
    fixturesCommit: fixturesCommit(),
    log: (line) => process.stdout.write(`${line}\n`),
  });

  const { totals } = report;
  process.stdout.write(`\n${report.target}: ${totals.pass} pass, ${totals.fail} fail, ${totals.note} note, ${totals.skip} skip\n`);
  if (args.report) {
    await writeFile(path.resolve(args.report), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`report written to ${args.report}\n`);
  }
  return exitCode(report);
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`${err?.stack ?? err}\n`);
    process.exit(2);
  },
);
