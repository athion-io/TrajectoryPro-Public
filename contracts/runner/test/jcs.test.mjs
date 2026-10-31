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

// RFC 8785 (JSON Canonicalization Scheme) tests. The number and sort cases
// are transcribed by hand from the RFC text (Section 3.2.3 and Appendix B).

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { canonicalize, sha256Digest, sameDigest } from '../src/jcs.mjs';
import { eventHash } from '../src/audit.mjs';

/** Builds the double whose IEEE-754 bit pattern is the given 16-hex string. */
function fromBits(hex) {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt('0x' + hex));
  return view.getFloat64(0);
}

describe('canonicalize: numbers (RFC 8785 Appendix B)', () => {
  const cases = [
    ['0000000000000000', '0'],
    ['8000000000000000', '0'], // -0 serialises as 0
    ['0000000000000001', '5e-324'],
    ['8000000000000001', '-5e-324'],
    ['3eb0c6f7a0b5ed8c', '9.999999999999997e-7'],
    ['3eb0c6f7a0b5ed8d', '0.000001'],
    ['41b3de4355555553', '333333333.3333332'],
    ['41b3de4355555554', '333333333.33333325'],
    ['41b3de4355555555', '333333333.3333333'],
    ['41b3de4355555556', '333333333.3333334'],
    ['41b3de4355555557', '333333333.33333343'],
    ['becbf647612f3696', '-0.0000033333333333333333'],
    ['43143ff3c1cb0959', '1424953923781206.2'],
  ];
  for (const [bits, expected] of cases) {
    test(`0x${bits} -> ${expected}`, () => {
      assert.equal(canonicalize(fromBits(bits)), expected);
    });
  }

  test('plain literals from RFC 3.2.3', () => {
    assert.equal(canonicalize(333333333.33333329), '333333333.3333333');
    assert.equal(canonicalize(4.50), '4.5');
    assert.equal(canonicalize(2e-3), '0.002');
    assert.equal(canonicalize(0.000000000000000000000000001), '1e-27');
    assert.equal(canonicalize(1e-7), '1e-7');
    assert.equal(canonicalize(-1.5), '-1.5');
    assert.equal(canonicalize(100), '100');
    assert.equal(canonicalize(9007199254740991), '9007199254740991');
    assert.equal(canonicalize(-9007199254740991), '-9007199254740991');
  });

  test('throws on NaN and Infinity (Appendix B: 0x7fffffffffffffff, 0x7ff0000000000000)', () => {
    assert.throws(() => canonicalize(fromBits('7fffffffffffffff')), /NaN|finite/);
    assert.throws(() => canonicalize(fromBits('7ff0000000000000')), /Infinity|finite/);
    assert.throws(() => canonicalize(-Infinity), /Infinity|finite/);
    assert.throws(() => canonicalize({ a: [1, NaN] }), /NaN|finite/);
  });

  test('renders values beyond 2^53 exactly as the RFC does (Appendix B)', () => {
    // An earlier revision refused these (I-JSON, RFC 7493). The golden
    // vectors from the primitives canon render 1e+20 and 1e+21, so the
    // runner renders them too; otherwise a trail the runtime hashed could
    // not be verified here.
    const big = [
      ['4340000000000000', '9007199254740992'],
      ['c340000000000000', '-9007199254740992'],
      ['4430000000000000', '295147905179352830000'],
      ['444b1ae4d6e2ef4e', '999999999999999700000'],
      ['444b1ae4d6e2ef4f', '999999999999999900000'],
      ['444b1ae4d6e2ef50', '1e+21'],
      ['44b52d02c7e14af5', '9.999999999999997e+22'],
      ['44b52d02c7e14af6', '1e+23'],
      ['44b52d02c7e14af7', '1.0000000000000001e+23'],
      ['7fefffffffffffff', '1.7976931348623157e+308'],
      ['ffefffffffffffff', '-1.7976931348623157e+308'],
    ];
    for (const [bits, expected] of big) {
      assert.equal(canonicalize(fromBits(bits)), expected, expected);
    }
    assert.equal(canonicalize(1e20), '100000000000000000000');
    assert.equal(canonicalize(1e30), '1e+30');
    assert.equal(canonicalize({ n: 9007199254740992 }), '{"n":9007199254740992}');
    assert.equal(canonicalize([0, [1e21]]), '[0,[1e+21]]');
  });
});

describe('canonicalize: strings (RFC 8785 3.2.2.2)', () => {
  test('escapes quote, backslash and the short-form controls', () => {
    assert.equal(canonicalize('"'), '"\\""');
    assert.equal(canonicalize('\\'), '"\\\\"');
    assert.equal(canonicalize('\b\t\n\f\r'), '"\\b\\t\\n\\f\\r"');
  });

  test('other control characters use lowercase \\u00xx', () => {
    assert.equal(canonicalize('\u0000'), '"\\u0000"');
    assert.equal(canonicalize('\u000f'), '"\\u000f"');
    assert.equal(canonicalize('\u001f'), '"\\u001f"');
    assert.equal(canonicalize('\u001b'), '"\\u001b"');
  });

  test('does not escape "/", DEL, C1 controls or non-ASCII', () => {
    assert.equal(canonicalize('/'), '"/"');
    assert.equal(canonicalize('\u007f'), '"\u007f"');
    assert.equal(canonicalize('\u0080'), '"\u0080"');
    assert.equal(canonicalize('\u20ac'), '"\u20ac"');
    assert.equal(canonicalize('\ud83d\ude00'), '"\ud83d\ude00"');
  });

  test('RFC 3.2.3 string sample', () => {
    const input = '\u20ac$\u000F\u000aA\'\u0042\u0022\u005c\\"\u002f';
    assert.equal(canonicalize(input), '"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"');
  });

  test('throws on lone surrogates in strings', () => {
    assert.throws(() => canonicalize('\ud83d'), /surrogate/);
    assert.throws(() => canonicalize('a\ude00b'), /surrogate/);
    assert.throws(() => canonicalize('\ude00\ud83d'), /surrogate/); // reversed pair
    assert.throws(() => canonicalize(['ok', { x: '\ud800' }]), /surrogate/);
  });

  test('throws on lone surrogates in keys', () => {
    assert.throws(() => canonicalize({ '\ud83d': 1 }), /surrogate/);
  });
});

describe('canonicalize: objects and arrays', () => {
  test('sorts keys by UTF-16 code units (RFC 3.2.3 sample)', () => {
    const input = {
      '\u20ac': 'Euro Sign',
      '\r': 'Carriage Return',
      '\ufb33': 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '\ud83d\ude00': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      '\u00f6': 'Latin Small Letter O With Diaeresis',
    };
    assert.equal(
      canonicalize(input),
      '{"\\r":"Carriage Return","1":"One","\u0080":"Control",'
        + '"\u00f6":"Latin Small Letter O With Diaeresis","\u20ac":"Euro Sign",'
        + '"\ud83d\ude00":"Emoji: Grinning Face","\ufb33":"Hebrew Letter Dalet With Dagesh"}',
    );
  });

  test('"\\u20ac" sorts before "\\ud83d\\ude00" (code unit 0x20ac < 0xd83d)', () => {
    assert.equal(canonicalize({ '\ud83d\ude00': 2, '\u20ac': 1 }), '{"\u20ac":1,"\ud83d\ude00":2}');
  });

  test('sorts by code units, not by code points or locale', () => {
    // U+FF21 (fullwidth A) is one code unit 0xff21; U+1D400 is a pair starting 0xd835.
    assert.equal(canonicalize({ '\uff21': 1, '\ud835\udc00': 2 }), '{"\ud835\udc00":2,"\uff21":1}');
    assert.equal(canonicalize({ b: 1, B: 2, a: 3, A: 4 }), '{"A":4,"B":2,"a":3,"b":1}');
    assert.equal(canonicalize({ 10: 1, 9: 2, '': 3 }), '{"":3,"10":1,"9":2}');
  });

  test('RFC 3.2.3 full sample', () => {
    const input = {
      numbers: [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      string: '\u20ac$\u000F\u000aA\'\u0042\u0022\u005c\\"\u002f',
      literals: [null, true, false],
    };
    assert.equal(
      canonicalize(input),
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],'
        + '"string":"\u20ac$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  test('nested arrays and objects, no whitespace', () => {
    assert.equal(canonicalize([]), '[]');
    assert.equal(canonicalize({}), '{}');
    assert.equal(canonicalize([[], {}, [[1, [2]]]]), '[[],{},[[1,[2]]]]');
    assert.equal(
      canonicalize({ z: { b: [1, { d: null, c: 'x' }], a: true }, a: [false] }),
      '{"a":[false],"z":{"a":true,"b":[1,{"c":"x","d":null}]}}',
    );
  });

  test('literals', () => {
    assert.equal(canonicalize(null), 'null');
    assert.equal(canonicalize(true), 'true');
    assert.equal(canonicalize(false), 'false');
  });

  test('throws on values JSON cannot carry', () => {
    assert.throws(() => canonicalize(undefined), /undefined/);
    assert.throws(() => canonicalize({ a: undefined }), /undefined/);
    assert.throws(() => canonicalize([1, undefined]), /undefined/);
    assert.throws(() => canonicalize(() => 1), /function/);
    assert.throws(() => canonicalize(Symbol('s')), /symbol/);
    assert.throws(() => canonicalize(10n), /bigint/);
  });
});

describe('sha256Digest', () => {
  test('hashes a string as UTF-8 and renders sha256:<hex>', () => {
    assert.equal(
      sha256Digest(''),
      'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    assert.equal(
      sha256Digest('abc'),
      'sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    // "€" is e2 82 ac in UTF-8; the same bytes must give the same digest.
    assert.equal(sha256Digest('\u20ac'), sha256Digest(new Uint8Array([0xe2, 0x82, 0xac])));
  });

  test('accepts Uint8Array and ArrayBuffer', () => {
    const bytes = new TextEncoder().encode('abc');
    assert.equal(sha256Digest(bytes), sha256Digest('abc'));
    assert.equal(sha256Digest(bytes.buffer.slice(0, 3)), sha256Digest('abc'));
  });

  test('rejects other input types', () => {
    assert.throws(() => sha256Digest(42), TypeError);
    assert.throws(() => sha256Digest({ a: 1 }), TypeError);
  });
});

describe('sameDigest', () => {
  const hex = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

  test('prefixed vs bare, case-insensitive hex', () => {
    assert.equal(sameDigest(`sha256:${hex}`, `sha256:${hex}`), true);
    assert.equal(sameDigest(`sha256:${hex}`, hex), true);
    assert.equal(sameDigest(hex, `sha256:${hex}`), true);
    assert.equal(sameDigest(hex.toUpperCase(), `sha256:${hex}`), true);
    assert.equal(sameDigest(`SHA256:${hex}`, hex), true);
  });

  test('different digests are not the same', () => {
    const other = hex.slice(0, -1) + 'e';
    assert.equal(sameDigest(`sha256:${hex}`, `sha256:${other}`), false);
  });

  test('malformed values are never the same (no throw)', () => {
    assert.equal(sameDigest('', ''), false);
    assert.equal(sameDigest(hex.slice(1), hex.slice(1)), false);
    assert.equal(sameDigest(`sha256:${hex}z`, `sha256:${hex}z`), false);
    assert.equal(sameDigest(`md5:${hex}`, `md5:${hex}`), false);
    assert.equal(sameDigest(`sha256:${hex}`, undefined), false);
    assert.equal(sameDigest(null, null), false);
    assert.equal(sameDigest(42, 42), false);
  });
});

describe('golden vectors (audit-trail/fixtures/vectors/audit-vectors.json)', () => {
  // Generated upstream by the Athion primitives canon (commit c115860f,
  // recipe athion-canon/2) and copied in byte for byte; never edited by hand.
  // The file's SHA-256 below pins its content, including the provenance
  // fields in `meta`, so nothing else about its origin is asserted here. The
  // runner must produce the same canonical string and the same digest for
  // every input, or the two sides do not agree on what an event hashes to.
  // The vectors are read at describe time because they drive test generation.
  const VECTORS_FILE = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', 'audit-trail', 'fixtures', 'vectors', 'audit-vectors.json',
  );
  const FILE_SHA256 = '0aa401b8322fa54aa29d13bafd819bfb1beef10845e5ecf48461953aaf43eaaa';

  const raw = readFileSync(VECTORS_FILE);
  const doc = JSON.parse(raw.toString('utf8'));

  test('the committed file is the verified byte-for-byte copy', () => {
    assert.equal(createHash('sha256').update(raw).digest('hex'), FILE_SHA256);
    assert.equal(doc.vectors.length, 12);
  });

  test('every vector has a unique name and a sha256:<hex> digest', () => {
    const names = doc.vectors.map((v) => v.name);
    assert.equal(new Set(names).size, names.length);
    for (const v of doc.vectors) {
      assert.deepEqual(Object.keys(v).sort(), ['canonical', 'hash', 'input', 'name'], v.name);
      assert.match(v.hash, /^sha256:[0-9a-f]{64}$/, v.name);
    }
  });

  // The vectors say hash = sha256(canonical). Both checks are separate so a
  // failure names which half (the bytes or the digest) disagrees.
  for (const v of doc.vectors) {
    test(`${v.name}: canonicalize(input) is the canonical string byte for byte`, () => {
      assert.equal(canonicalize(v.input), v.canonical);
      assert.equal(
        Buffer.from(canonicalize(v.input), 'utf8').toString('hex'),
        Buffer.from(v.canonical, 'utf8').toString('hex'),
      );
    });

    test(`${v.name}: sha256 of the canonical string is the hash`, () => {
      assert.equal(sha256Digest(v.canonical), v.hash);
      assert.equal(sha256Digest(canonicalize(v.input)), v.hash);
    });
  }

  test('event vectors: eventHash gives the same digest and the chain links as C-AUD-4 says', () => {
    // The event inputs carry no `hash` or `signature`, so the content hash
    // of C-AUD-3 is the digest of the whole input. That is what the vectors
    // claim, so eventHash and the vector hash must agree.
    const events = doc.vectors.filter((v) => v.name.startsWith('event-'));
    assert.equal(events.length, 3);
    for (const v of events) {
      assert.equal(eventHash(v.input), v.hash, v.name);
      assert.equal('hash' in v.input, false, v.name);
      assert.equal('signature' in v.input, false, v.name);
    }
    assert.equal(events[0].name, 'event-genesis');
    assert.equal(events[0].input.prev_hash, '');
    for (let i = 1; i < events.length; i++) {
      assert.equal(events[i].input.prev_hash, events[i - 1].hash, events[i].name);
      assert.ok(sameDigest(events[i].input.prev_hash, eventHash(events[i - 1].input)), events[i].name);
    }
  });

  test('the number vectors cover what RFC 8785 renders beyond 2^53', () => {
    // These are the cases the runner once refused: the primitives side
    // renders them exactly as ECMAScript does, and so does the runner now.
    const large = doc.vectors.find((v) => v.name === 'number-large');
    assert.equal(large.canonical, '{"k":123456789012345,"m":100000000000000000000,"n":1e+21}');
    const negZero = doc.vectors.find((v) => v.name === 'number-negative-zero');
    assert.equal(negZero.canonical, '{"k":[0,0],"m":-1.5,"n":0}');
    const small = doc.vectors.find((v) => v.name === 'number-small');
    assert.equal(small.canonical, '{"k":0.000001,"m":1e-7,"n":0.1}');
  });
});