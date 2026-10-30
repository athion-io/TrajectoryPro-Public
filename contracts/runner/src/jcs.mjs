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

// JSON Canonicalization Scheme (RFC 8785) and the SHA-256 content digest used
// by the audit-trail contract (C-AUD-3). Numbers follow the ECMAScript
// Number-to-String algorithm, which the RFC adopts; strings escape only what
// RFC 8785 3.2.2.2 lists; object keys sort by UTF-16 code units.
//
// Two deliberate restrictions beyond the RFC keep every implementation
// language honest about the same bytes: integers outside ±(2^53-1) are
// refused (I-JSON, RFC 7493) — and since every double with |n| >= 2^53 is a
// whole number, that refuses 1e+21 and 1.7976931348623157e+308 as well — and
// lone surrogates are refused rather than escaped. `undefined`, functions, symbols and bigints have no JSON form and
// are refused too.

import { createHash } from 'node:crypto';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const DIGEST_RE = /^(?:sha256:)?([0-9a-f]{64})$/i;

/**
 * Serialises a JSON value per RFC 8785.
 * @param {unknown} value
 * @returns {string}
 */
export function canonicalize(value) {
  const out = [];
  write(value, out, '$');
  return out.join('');
}

/**
 * SHA-256 of a string (as UTF-8) or of raw bytes, rendered `sha256:<hex>`.
 * @param {string | Uint8Array | ArrayBuffer} bytesOrString
 * @returns {string}
 */
export function sha256Digest(bytesOrString) {
  let bytes;
  if (typeof bytesOrString === 'string') bytes = Buffer.from(bytesOrString, 'utf8');
  else if (bytesOrString instanceof Uint8Array) bytes = bytesOrString;
  else if (bytesOrString instanceof ArrayBuffer) bytes = new Uint8Array(bytesOrString);
  else throw new TypeError('sha256Digest expects a string, Uint8Array or ArrayBuffer');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * True when two digests name the same SHA-256 value. Either side may be
 * `sha256:<hex>` or bare 64-hex, in any case. Anything else is never equal.
 * @param {unknown} a
 * @param {unknown} b
 * @returns {boolean}
 */
export function sameDigest(a, b) {
  const x = digestHex(a);
  const y = digestHex(b);
  return x !== null && y !== null && x === y;
}

function digestHex(value) {
  if (typeof value !== 'string') return null;
  const m = DIGEST_RE.exec(value);
  return m ? m[1].toLowerCase() : null;
}

function write(value, out, path) {
  if (value === null) { out.push('null'); return; }
  switch (typeof value) {
    case 'boolean': out.push(value ? 'true' : 'false'); return;
    case 'number': out.push(numberText(value, path)); return;
    case 'string': out.push(stringText(value, path)); return;
    case 'object': break;
    default:
      throw new TypeError(`canonicalize: ${typeof value} at ${path} has no JSON form`);
  }
  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(',');
      write(value[i], out, `${path}[${i}]`);
    }
    out.push(']');
    return;
  }
  const keys = Object.keys(value).sort(compareCodeUnits);
  out.push('{');
  for (let i = 0; i < keys.length; i++) {
    if (i > 0) out.push(',');
    out.push(stringText(keys[i], `${path} key`), ':');
    write(value[keys[i]], out, `${path}.${keys[i]}`);
  }
  out.push('}');
}

function numberText(n, path) {
  if (Number.isNaN(n)) throw new RangeError(`canonicalize: NaN at ${path} is not finite`);
  if (!Number.isFinite(n)) throw new RangeError(`canonicalize: Infinity at ${path} is not finite`);
  if (Number.isInteger(n) && Math.abs(n) > MAX_SAFE) {
    throw new RangeError(`canonicalize: integer at ${path} is outside the safe range (|n| > 2^53-1)`);
  }
  return Object.is(n, -0) ? '0' : String(n);
}

function stringText(s, path) {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (d < 0xdc00 || d > 0xdfff) throw new RangeError(`canonicalize: lone surrogate at ${path}`);
      out += s[i] + s[i + 1];
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      throw new RangeError(`canonicalize: lone surrogate at ${path}`);
    } else if (c === 0x22) out += '\\"';
    else if (c === 0x5c) out += '\\\\';
    else if (c >= 0x20) out += s[i];
    else if (c === 0x08) out += '\\b';
    else if (c === 0x09) out += '\\t';
    else if (c === 0x0a) out += '\\n';
    else if (c === 0x0c) out += '\\f';
    else if (c === 0x0d) out += '\\r';
    else out += '\\u' + c.toString(16).padStart(4, '0');
  }
  return out + '"';
}

// Default string comparison already orders by UTF-16 code units; this spells
// it out so nobody swaps in localeCompare.
function compareCodeUnits(a, b) {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = a.charCodeAt(i) - b.charCodeAt(i);
    if (d !== 0) return d;
  }
  return a.length - b.length;
}
