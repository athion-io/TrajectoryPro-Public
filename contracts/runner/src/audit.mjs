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

// Offline audit-trail verifier (audit-trail contract C-AUD-3..6). An event's
// `hash` is the SHA-256 of the JCS form of the event with `hash` and
// `signature` removed; every other field, known or not, is hashed. The genesis
// event's `prev_hash` is "". Digests may be `sha256:<hex>` or bare hex.

import { canonicalize, sha256Digest, sameDigest } from './jcs.mjs';

/**
 * @typedef {'altered' | 'broken_link' | 'bad_genesis' | 'duplicate_id' | 'secret_in_payload'} IssueKind
 * @typedef {{ index: number, id: unknown, issue: IssueKind }} ChainIssue
 */

/** Payload keys that must never hold a value (C-AUD-6). */
export const SECRET_KEY_RE = /(password|secret|token|api[_-]?key)/i;

/**
 * Content digest of an event: canonical form minus `hash` and `signature`.
 * @param {Record<string, unknown>} event
 * @returns {string}
 */
export function eventHash(event) {
  if (!isPlainObject(event)) throw new TypeError('eventHash expects an event object');
  const { hash, signature, ...content } = event;
  return sha256Digest(canonicalize(content));
}

/**
 * Checks a trail in file order. Returns one entry per problem, ordered by
 * index; within one event the order is altered, bad_genesis / broken_link,
 * duplicate_id, secret_in_payload. Issues never include payload values.
 * Events must be canonicalizable; otherwise `canonicalize` throws.
 * @param {Array<Record<string, unknown>>} events
 * @returns {ChainIssue[]}
 */
export function verifyChain(events) {
  if (!Array.isArray(events)) throw new TypeError('verifyChain expects an array of events');
  const issues = [];
  const seen = new Set();
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (!isPlainObject(event)) throw new TypeError(`verifyChain: event ${index} is not an object`);
    const id = 'id' in event ? event.id : null;
    const report = (issue) => issues.push({ index, id, issue });

    if (!sameDigest(event.hash, eventHash(event))) report('altered');

    if (index === 0) {
      if (event.prev_hash !== '') report('bad_genesis');
    } else if (!sameDigest(event.prev_hash, events[index - 1].hash)) {
      report('broken_link');
    }

    const idKey = typeof id === 'string' ? `s:${id}` : `j:${canonicalize(id)}`;
    if (seen.has(idKey)) report('duplicate_id');
    seen.add(idKey);

    if (holdsSecret(event.payload)) report('secret_in_payload');
  }
  return issues;
}

/** True when any key at any depth matches SECRET_KEY_RE and holds a non-empty string. */
function holdsSecret(value) {
  if (Array.isArray(value)) return value.some(holdsSecret);
  if (!isPlainObject(value)) return false;
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEY_RE.test(key) && typeof inner === 'string' && inner !== '') return true;
    if (holdsSecret(inner)) return true;
  }
  return false;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
