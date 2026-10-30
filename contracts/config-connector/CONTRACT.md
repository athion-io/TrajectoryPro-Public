<!--
Copyright 2026 Athion, Inc.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
-->

# Plant-configuration connector contract (`config-connector`)

Conformance clauses for the **connector** that applies a reviewed change to
a plant-configuration file: take the exported file, check that each item
still holds the value the reviewer saw, patch exactly those items, hash
before and after, and read the result back honestly. The model is
vendor-neutral; the first two profiles are a DeltaV FHX export and a Mimic
XML export, but no fixture in this directory contains vendor or customer
content (§1.4).

Levels follow `contracts/README.md`: **MUST** fixtures gate the exit code.
Every fixture in this directory is MUST and cites its clause in `source` as
`C-CFG-<n>`.

Fixtures live in [`fixtures/`](fixtures/), one per file,
`cfg-<nnn>-<slug>.json`. The synthetic files they patch live in
[`fixtures/files/`](fixtures/files/).

## 1. Model

### 1.1 The apply request

Every fixture is one call to the conformance probe (§4):

```json
POST {probe_url}/connector/apply
{
  "profile":  "deltav-fhx" | "mimic-xml",
  "mode":     "test",
  "file_b64": "<base64 of the exported file bytes>",
  "changes": [
    { "platform": "<profile>", "item": "<object>/<parameter>", "from": "<text>", "to": "<text>" }
  ]
}
```

- `profile` names the file format (C-CFG-5). `changes[].platform` repeats
  it; a mismatch is `400 VALIDATION_ERROR`.
- `mode` is `"test"` in every fixture here: the connector patches the
  bytes it was given and returns them; it never imports into a live system
  (C-CFG-3). Other modes are out of scope for this contract.
- `file_b64` is the exported file, standard base64 (RFC 4648 §4, with
  padding) of the raw bytes. Live fixtures (§5) replace it with `source`.
- `item` is `<object>/<parameter>`, split at the **last** slash. For
  `deltav-fhx` the object is a `MODULE NAME` and the parameter an
  `ATTRIBUTE_INSTANCE NAME`; for `mimic-xml` the object is an `<object
  name>` and the parameter a `<param name>`.
- `from` and `to` are the parameter's value **as text**, exactly as it
  appears in the file. The connector does not parse numbers: `"10.0"` and
  `"10"` are different values.

### 1.2 The apply response

```json
200 { "data": {
        "after_b64":   "<base64 of the patched file bytes>",
        "before_hash": "sha256:<64 hex>",
        "after_hash":  "sha256:<64 hex>",
        "read_back":   { "ok": true|false,
                         "mismatches": [ { "item", "expected", "actual" } ] }
      }, "meta": {} }
```

- `before_hash` / `after_hash` are **SHA-256 over the raw file bytes**
  (the decoded `file_b64`, and the bytes encoded in `after_b64`), rendered
  as lowercase hex with the `sha256:` prefix — the same rendering as the
  audit trail's `hash` (`contracts/audit-trail/CONTRACT.md`). No
  canonicalisation, no line-ending normalisation: the hash is of the bytes.
- `read_back` is the connector re-reading every changed item from the
  patched file (C-CFG-2). `ok` is `true` only when every item reads back
  as its `to`; each item that does not is listed once in `mismatches` with
  the requested `expected` and the read `actual`.

Refusals use the REST error envelope (`docs/REST_Protocol.md` §1.5) with
`details` naming the item:

| status | code | when | `details` |
|---|---|---|---|
| 409 | `STALE_VALUE` | an item's current value is not `from` (C-CFG-1) | `item`, `expected` (= `from`), `actual` |
| 400 | `ITEM_NOT_FOUND` | an item is not in the file | `item` |
| 400 | `VALIDATION_ERROR` | malformed body, unknown profile, mode other than `test`, missing `file_b64` | — |

A refusal has no `data`; the file is untouched (nothing was written, so
there is nothing to return).

### 1.3 All-or-nothing over the change list

Every change is checked (item present, value equals `from`) **before** any
is applied, so a stale or unknown item anywhere in the list refuses the
whole request and leaves the file as it was. The fixtures here use one
change per request; the rule matters for the multi-change case.

### 1.4 Synthetic files

The files under `fixtures/files/` are hand-written, a few lines each, and
say in their first line that they are synthetic. They borrow the *shape*
of an FHX or XML export (`MODULE NAME="…" { ATTRIBUTE_INSTANCE … }`,
`<object name="…"><param name="…">`) so a connector's parser has
something to bite on, but their objects are `FAKE_PUMP_A`, `FAKE_TANK_B`
and so on. They are not vendor files, carry no real plant tags, and are
not a specification of either vendor's grammar. They are committed with
`* -text` so line endings (LF) and therefore hashes are stable on every
checkout; the suite test verifies the committed bytes against the hashes
in the fixtures.

Golden "after" files sit beside each "before" file, one per fixture that
patches it; each differs from its "before" on exactly one line.

## 2. Clauses

- **C-CFG-1 (stale `from` refused).** The connector MUST refuse a change
  whose item does not currently hold `from`, with `409 STALE_VALUE` and
  `details {item, expected, actual}`, and MUST change nothing.
- **C-CFG-2 (honest read-back).** After writing, the connector MUST
  re-read every changed item from the result and return `read_back {ok,
  mismatches[{item, expected, actual}]}`. `ok` MUST be `true` only if every
  item reads back as its `to`. A connector MUST NOT report `ok: true` from
  the values it *asked* to write.
- **C-CFG-3 (content hashes; test mode never imports).** `before_hash`
  and `after_hash` MUST be SHA-256 of the file bytes, rendered
  `sha256:<hex>` (§1.2). In `test` mode the connector MUST NOT import,
  download or otherwise push the result into the live system.
- **C-CFG-4 (no collateral edits).** Every byte not on the line of a
  named item MUST be identical before and after. Same-named parameters on
  other objects are "not named" and MUST be untouched.
- **C-CFG-5 (named profiles).** Profiles are named. The first two are
  `deltav-fhx` and `mimic-xml`; an unknown profile is `400
  VALIDATION_ERROR`.

## 3. Conformance probe

The connector is exercised through the **conformance probe** declared by
the target's `probe_url` (`contracts/targets/*.target.json`; the toy uses
`…/conformance/v1`). Fixtures carry `requires: ["connector_probe"]` and
their single request step is marked `probe: true`, so it is sent to
`probe_url` instead of `base_url`. A target without `connector_probe`
skips all ten. Probe endpoints use the same `X-API-Key` header and the
REST envelope (`docs/REST_Protocol.md` §1.3, §1.5).

**`POST {probe_url}/connector/apply`** — body as §1.1. Answers `200` as
§1.2 or one of the refusals in the §1.2 table. It is a test-mode surface:
nothing it does reaches a live system.

### 3.1 Fixtures

| fixture | source | profile | case | expects |
|---|---|---|---|---|
| cfg-001 | C-CFG-4 | deltav-fhx | patch `FAKE_PUMP_A/SETPOINT` 10.0 → 12.5 | `after_b64` and both hashes equal the golden file; `read_back.ok` |
| cfg-002 | C-CFG-4 | mimic-xml | patch `FAKE_TANK_A/LEVEL_SP` 55 → 60 | as cfg-001 against the XML golden |
| cfg-003 | C-CFG-1 | deltav-fhx | `from` 11.0, file holds 10.0 | `409 STALE_VALUE`, `details {item, expected "11.0", actual "10.0"}`, no `data` |
| cfg-004 | C-CFG-1 | deltav-fhx | item `FAKE_PUMP_Z/SETPOINT` absent | `400 ITEM_NOT_FOUND`, `details.item`, no `data` |
| cfg-005 | C-CFG-4 | mimic-xml | patch `FAKE_TANK_B/LEVEL_SP`; `FAKE_TANK_A` has the same parameter | golden after leaves `FAKE_TANK_A/LEVEL_SP` at 55 |
| cfg-006 | C-CFG-2 | deltav-fhx | write 150.0 to a SETPOINT the system clamps to `HI_LIMIT` 90.0 | `read_back.ok false`, one mismatch `{expected "150.0", actual "90.0"}`; `after_hash ≠ before_hash` |
| cfg-100 | C-CFG-3 | deltav-fhx | **live**: download route | see §4 |
| cfg-101 | C-CFG-3 | deltav-fhx | **live**: reload route | see §4 |
| cfg-102 | C-CFG-3 | mimic-xml | **live**: download route | see §4 |
| cfg-103 | C-CFG-3 | mimic-xml | **live**: reload route | see §4 |

cfg-006 is the clause-2 teeth: a connector that reports success from what
it *requested* passes cfg-001..005 and fails here. The toy stands in for
the normalising system by clamping `SETPOINT` to the module's `HI_LIMIT`
(§5); a real connector meets the same fixture by reading the file it
actually produced.

## 4. Live-vendor fixtures (cfg-100..103)

Context decision D13: fixtures against real DeltaV and Mimic exports and
their download/reload routes are **written but tagged `live`**, and the
runner skips them (reason `live fixture; target has no live_vendor`)
unless the target declares `"live_vendor": true`. They stay skipped until
plan 4 verifies the routes on a vendor system.

Their bodies replace `file_b64` with
`"source": {"kind": "live", "route": "download" | "reload"}` and name a
placeholder item `LIVE_OBJECT/LIVE_PARAMETER` with `from "0"`, `to "1"`.
Their expectations are deliberately loose — both hashes match
`^sha256:[0-9a-f]{64}$`, `read_back.ok` is true, no `error` — because the
real file contents are unknown here. **The `source` shape, the route
names and the placeholder item are provisional** and will be finalised by
plan 4; the ids, tags and clause are fixed. The toy does not implement
`source` and answers `400 VALIDATION_ERROR` if a target forces them to run.

## 5. Expected results against the toy

The in-process toy (`contracts/runner/test/toy-container.mjs`) mounts the
probe at `/conformance/v1` and patches with the exported pure function
`applyChanges`, which knows the two profiles in §1.4 line by line. With no
defects: **6 pass, 0 fail, 0 note, 4 skip** (the four live fixtures), exit
`0`. The `lying-readback` defect reports `read_back.ok: true` with no
mismatches regardless of what the file holds and fails exactly
**cfg-006**; cfg-001..005 read back correctly either way. A copy of the
toy target without `connector_probe` gives **0 pass, 0 fail, 0 note, 10
skip**, exit `0`. A copy with `"live_vendor": true` runs cfg-100..103
instead of skipping them; against the toy they fail (no live `source`),
which is the intended behaviour of a target that claims more than it has.
