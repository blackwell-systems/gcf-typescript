# Changelog

## v2.4.0 (2026-07-12)

### Fixes

- Decoder: reject an orphan `.field` attachment (a `.field` whose name is neither a `^`-marked column of its row nor a `>`-containing field name, SPEC 7.4.6.1.4) instead of silently absorbing it as an undeclared extra field. Such a stray attachment previously decoded to a record no encoder produces, silently injecting a field onto the last-parsed row (a lossless round-trip hole); now rejected per SPEC 16.5 (`orphan_attachment`).
- Decoder: reject an orphan positional inline body (a pipe-delimited line with no eligible `^{}` attachment-marker cell) instead of silently dropping it. The object-body parser previously skipped any unrecognized line, so a stray positional body (e.g. a second `Bob|b@t.com` after a row's one inline cell was filled) vanished with no error (silent data loss); now rejected per SPEC 16.5 (`orphan_inline_attachment`).
- Graph streaming trailer: the edge count is now always the last `counts` entry, even when the stream has no edges (positional `counts=2,1,0`; labeled `counts=…,edges:0`). A zero-edge stream previously dropped it, violating the SPEC §8.4 / §8.4.1 rule that the edge count is always present and last (the invariant that keeps the positional form unambiguous). The graph trailer is decoder-ignored, so this changes producer output only.

### Streaming: opt-in labeled trailer counts (SPEC §8.4.1)

- New `labeledTrailerCounts` stream option on `StreamEncoder`. When set, the `##! summary` graph streaming trailer emits `counts=` in the labeled form `label:count` per group (e.g. `counts=targets:2,related:1,edges:3`) instead of the default positional values-only form (`counts=2,1,3`). Default false is byte-identical to prior output.
- Opt-in and non-breaking: a producer-side comprehension aid for known weak consumers. The trailer counts remain informational (decoder-ignored) in both forms; neither changes the decoded payload. Mirrors the `gcf-go` reference.

### Conformance and docs

- The conformance runner now executes the `graph-stream-encode` fixtures (streaming-encode parity, previously decode-only): fixture 004 (positional trailer) and 005 (labeled trailer).
- README: corrected the streaming example trailer from the defunct `## _summary … sections=` to the real `##! summary … counts=`; README now leads with the project diagram.

## v2.3.0 (2026-07-12)

### Generic-profile delta encoding (SPEC §10a)

- Full producer + consumer implementation of generic-profile delta, byte-for-byte interoperable with `gcf-go` and `gcf-python`:
  - `GenericSet` (keyed record set), `GenericDeltaPayload`
  - `genericPackRoot` (`gcf-pack-root-v1`, generic profile) with a purpose-built cell canonicalization (`canonicalCell`) decoupled from the wire cell encoder: collision-free (null/bool/number bare, strings always quoted) and record-safe. Fields and records sort by UTF-8 byte order (`Buffer.compare`) to match Go's `sort.Strings`, so pack roots are identical across SDKs.
  - `diffGenericSets` (the blessed producer path; centralizes the keyed-diff invariants), `encodeGenericFull`, `encodeGenericDelta`
  - `decodeGenericFull`, `decodeGenericDelta` (consumer wire parsing)
  - `verifyGenericDelta` (atomic apply + `new_root` verification)
- Delta is opt-in and bilateral; the existing `encodeGeneric` path is unchanged (backward compatible). Node-only (uses `crypto.createHash`), exported from the main entry alongside `packRoot`/`verifyDelta`.
- `GenericDeltaSession` (SPEC §10a.8): producer-side re-anchor cadence helper over the delta primitives. Emits either a compact delta or, on its policy's cadence, a full re-anchor (a schema change always forces a full per §10a.7); introduces no new wire syntax. Policies: `fixedN(n)` (default `DEFAULT_REANCHOR_N = 15`) and `sizeGuard()` (re-anchors once cumulative delta bytes reach the current full-payload byte size). Byte-length comparisons use UTF-8 bytes (`Buffer.byteLength`) to match Go's `len(string)`, so cadence is identical across SDKs. Exports: `GenericDeltaSession`, `ReanchorMode`, `fixedN`, `sizeGuard`, `DEFAULT_REANCHOR_N`, `ReanchorPolicy`. Shared conformance fixtures `generic-delta-session/001`–`003` verified against `gcf-go`.

### Tests

- Unit suite mirroring `gcf-go`/`gcf-python`: self-proving round-trip (diff -> encode -> apply -> recomputed root), determinism / row-order invariance, no-type-collision canonicalization, every invariant/error path, full-payload wire round-trip, the complete server -> wire -> consumer end-to-end loop, and malformed-wire-fails-closed.
- Conformance runner support for `generic-pack-root`, `generic-delta`, `generic-delta-verify`, `generic-delta-decode` (12 shared fixtures); verified to produce identical pack roots and delta wire to `gcf-go` and `gcf-python`.
- Generic-delta fuzz (`generic_delta_fuzz.test.ts`), mirroring `gcf-go`: the decoder never throws uncontrolled on arbitrary/mutated input, and arbitrary UTF-8 string cells (including multi-byte and control characters) survive the full-wire round-trip with the pack root preserved.

## v2.2.3 (2026-07-10)

### Fixes

- **Losslessness (nested null):** a nested object that is null at an intermediate level (e.g. `{meta:{owner:null}}`) is no longer flattened. Previously its leaves encoded as absent (`~`) and unflattened to a missing key, silently dropping the null. Such fields now fall back to the attachment mechanism; a top-level null still flattens losslessly (emits `-`, reconstructs via the all-null rule). This is a cross-SDK format-logic bug; regression fixtures added to the conformance suite (`flatten/017`–`019`).
- **Prototype pollution (JS/TS-specific):** the generic decoder no longer mutates `Object.prototype`. `unflattenPaths`, `checkDup`, the object-build assignments and the tabular row merge used `key in obj` and bracket assignment, so a `__proto__` path segment could pollute the prototype and any key shadowing an `Object.prototype` member (`toString`/`constructor`) was misparsed as a duplicate. Membership now uses `Object.prototype.hasOwnProperty.call`; a shared `safeAssign` writes a literal `__proto__` as an own property via `Object.defineProperty`; `unflattenPaths` drops unsafe path segments and guards non-object intermediates; `canonicalShape` uses `Object.create(null)` and rejects `__proto__`/`constructor`/`prototype`. Keys named `toString`/`constructor`/`valueOf` now round-trip correctly.
- Strict count parsing: shared-schema row counts use the strict `parseCount` helper instead of a loose `parseInt`.

### Tests

- `prototype_pollution.test.ts`: nested and top-level `__proto__` own-keys, hostile `>__proto__>` path column, and built-in-named keys.
- Property-based round-trip now exercises the v3.2 flatten path: `genFlattenableArray` generates aligned arrays whose shared fields are fixed-shape nested objects with a field or an intermediate level sometimes null/absent — the shape the prior scalar-only generator never produced. Verified to fail on the pre-fix encoder and pass on the fix (500k iterations).

## v2.2.2 (2026-06-30)

### Build

- npm provenance attestations enabled (published from GitHub Actions with `--provenance`)
- Verifiable build origin: every release links to source commit and CI workflow

## v2.2.1 (2026-06-23)

### Flatten Opt-Out

- Added `GenericOptions` interface with `noFlatten` option to disable nested object flattening
- `encodeGeneric(data, { noFlatten: true })` produces attachment syntax instead of path columns
- Backward compatible: `encodeGeneric(data)` behavior unchanged (flatten on by default)
- Fixed: field names containing `>` no longer appear as tabular columns (spec rule 7.4.6.1.4)
- Fixed: field names containing `>` no longer eligible for flattening analysis
- Fixed: decoder no longer treats literal `>` in key names as a path separator
- Fixed: decoder accepts orphan attachments (fields excluded from column list)
- Fuzz key generator now includes `>` for adversarial testing; 12 targeted edge case tests

## v2.2.0 (2026-06-22)

### Spec v3.2: Nested Object Flattening

- Encoder automatically flattens fixed-shape nested objects into `>` path column names (e.g., `"customer>name"` instead of `^` + `.customer {}` attachment)
- Decoder reconstructs nested objects from `>` path columns
- 20-48% fewer tokens on deeply nested API data (Jira, Stripe, K8s, calendar events)
- 100% comprehension on every frontier model (validated across 9 models, 7 providers)
- Zero regression on lossless round-trips (200K random + adversarial)
- Falls back to attachment mechanism for: variable-length arrays, objects with different keys across rows, objects with `>` in key names, empty nested objects

## v2.1.0 (2026-06-14)

### Spec v3.1

- `tool` field in graph profile header is now optional (SHOULD be present for MCP, not required)

### Bug Fixes

- Quote strings containing commas (conformance: `inline-schema/006_inline_with_quoted_values`)
- Decode v2-format indented attachments in tabular rows (conformance: `decode/002_attachment`)
- Reject duplicate attachments on the same row (conformance: `errors-v2/027_duplicate_attachment`)

## v2.0.0 (2026-06-12)

### Breaking Changes

- `encodeGeneric` now produces inline schema format (not backwards compatible with v1.x decoders)
- Attachment lines no longer indented (same depth as parent row)
- Inline object fields use positional encoding without field-name prefix

### New Features

- Inline object schema: objects with 3+ scalar fields encoded positionally with `^{fields}` header
- Shared array schemas: identical nested arrays omit `{fields}` after first row
- 472M+ fuzz iterations across all 6 implementations, zero failures

### Bug Fixes

- Quote strings starting with `.` (dot prefix)
- Quote C1 control characters (U+0080-U+009F)
- Quote Unicode whitespace (NBSP, hair space, etc.)

## v1.0.1 (2026-06-10)

- CLI: `encode-generic` and `decode-generic` subcommands for generic profile
- CLI now supports both graph and generic profiles

## v1.0.0 (2026-06-07)

- SPEC v2.0 implementation: common scalar grammar, full JSON escaping, attachments, expanded form
- 40M property-based round-trips with zero failures
- 130/141 conformance fixtures passing

## v0.6.0 (2026-06-06)

- `GenericStreamEncoder`: zero-buffering generic streaming encode (beginArray/writeRow/endArray/writeKV/writeSection/writeInlineArray)
- Repositioned as drop-in JSON replacement for AI pipelines

## v0.5.0 (2026-06-06)

- `decodeGeneric`: decode any GCF text (generic or graph) back to JS objects
- `StreamEncoder`: zero-buffering graph streaming encode

## v0.3.0 (2026-06-05)

- `encodeGeneric`: primitive arrays inlined as `name[N]: val1,val2,val3`
- Fix: empty arrays no longer produce invalid `name[0]:` output

## v0.2.0 (2026-06-05)

- **Breaking**: `encode()` now emits `edges=N` in header line
- **Breaking**: `encode()` now emits `## edges [N]` section header (was `## edges`)
- `decode()` updated to parse `## edges [N]` format (strips bracket suffix)
- Session encoder updated to emit new edge count format

## v0.1.3 (2026-06-04)

- Docs: update README for npm/PyPI discoverability (gcformat.com, proxy, vs-toon links)

## v0.1.2 (2026-06-04)

- Fix: quote empty strings as `""` in `encodeGeneric` per spec
- Fix: decoder rejects headers missing required `tool` field (conformance)

## v0.1.1 (2026-06-03)

- `encodeGeneric`: encode arbitrary JS values into GCF tabular format
- Tabular encoding: positional rows with pipe separators, section headers, nested field support
- Uniform array detection with 70% key overlap threshold

## v0.1.0 (2026-06-03)

- Initial release
- `encode` / `decode`: full GCF round-trip
- `encodeWithSession`: session deduplication (92.7% savings by 5th call)
- `encodeDelta`: delta encoding for re-queries (81.2% savings)
- `Session` class
- 16 kind abbreviations
- CLI: `gcf encode`, `gcf decode`, `gcf stats`
- ESM module, zero runtime dependencies
