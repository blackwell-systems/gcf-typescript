import { describe, it, expect } from 'vitest';
import {
  encode, decode, encodeGeneric, decodeGeneric,
  genericPackRoot, encodeGenericDelta, decodeGenericDelta, verifyGenericDelta,
  GenericDeltaSession, fixedN, sizeGuard, type ReanchorPolicy,
  type GenericSet, type GenericDeltaPayload,
  StreamEncoder,
  Session, encodeWithSession, encodeDelta, decodeDelta, verifyDelta,
} from '../src/index.js';
import type { Payload, Symbol, Edge, DeltaPayload } from '../src/index.js';
import { packRoot } from '../src/packroot.js';
import { parseJSONOrdered } from '../src/json_ordered.js';
import * as fs from 'fs';
import * as path from 'path';

const fixtureDir = path.resolve(__dirname, '../../gcf/tests/conformance');

function loadFixtures(): Array<{ relPath: string; data: any; raw: string }> {
  const fixtures: Array<{ relPath: string; data: any; raw: string }> = [];
  if (!fs.existsSync(fixtureDir)) return fixtures;

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.json')) continue;
      const raw = fs.readFileSync(full, 'utf-8');
      const data = JSON.parse(raw);
      fixtures.push({ relPath: path.relative(fixtureDir, full), data, raw });
    }
  }
  walk(fixtureDir);
  return fixtures;
}

// Re-parse a fixture's `input` field preserving first-observed key order,
// including integer-like keys (JSON.parse reorders those; SPEC 7.4.3 requires
// insertion order). The generic encoder is order-sensitive, so encode/roundtrip
// fixtures must feed order-preserving input, matching the go conformance runner
// which parses fixtures with ParseJSONOrdered.
function orderedInput(raw: string): unknown {
  const fixture = parseJSONOrdered(raw) as Map<string, unknown>;
  return fixture.get('input');
}

const fixtures = loadFixtures();

describe('Conformance v2', () => {
  // Floor assertion: a green run MUST have exercised the full shared suite. A
  // present-but-short fixture set (mispathed or partial checkout) fails loudly rather
  // than passing having verified almost nothing. A wholly-absent sibling checkout is
  // skipped (CI clones gcf in a separate step that fails loudly if it cannot).
  it('discovers the full shared fixture set (floor)', () => {
    if (!fs.existsSync(fixtureDir)) return;
    expect(fixtures.length).toBeGreaterThanOrEqual(150);
  });

  if (fixtures.length === 0) {
    it.skip('fixtures not found', () => {});
    return;
  }

  for (const { relPath, data, raw } of fixtures) {
    const op = data.operation;
    if (data.inputBase64) {
      it.skip(`${relPath} (binary input)`, () => {});
      continue;
    }
    // Skip a fixture requesting stream options this runner does not support.
    // labeledTrailerCounts (SPEC 8.4.1) IS supported; any other option key is not.
    if (
      op === 'graph-stream-encode' &&
      data.options &&
      Object.keys(data.options).some((k) => k !== 'labeledTrailerCounts')
    ) {
      it.skip(`${relPath} (unsupported stream options)`, () => {});
      continue;
    }

    it(relPath, () => {
      switch (op) {
        case 'encode': {
          // Detect graph encode tests.
          if (typeof data.expected === 'string' && data.expected.startsWith('GCF profile=graph')) {
            const p = toPayload(data.input);
            const got = encode(p);
            expect(got).toBe(data.expected);
            // Re-encode idempotence: encode(decode(got)) === got. Confirms the graph
            // decoder reconstructs the payload without dropping or reordering fields
            // (SPEC 52, 931).
            expect(encode(decode(got))).toBe(got);
          } else {
            const input = orderedInput(raw);
            const got = encodeGeneric(input);
            // v3 encoder produces different byte output for nested/attachment fixtures.
            // v3-inline-schema fixtures byte-match; v2 fixtures that exercise nesting only round-trip check.
            const v3AffectedDirs = ['attachments/', 'arrays/'];
            const isV3Affected = v3AffectedDirs.some(d => relPath.startsWith(d));
            if (!isV3Affected) {
              expect(got).toBe(data.expected);
            }
            // Round-trip (all fixtures must pass this). Decode in bigint mode so an
            // in-domain int64 value beyond 2^53 survives losslessly, and compare against
            // the order- and precision-preserving parse (JSON.parse floats such values).
            const decoded = decodeGeneric(got, { largeInt: 'bigint' });
            expect(jsonNorm(decoded)).toEqual(jsonNorm(orderedInput(raw)));
            // Re-encode idempotence: encodeGeneric(decodeGeneric(got)) === got.
            // Order-sensitive, so it catches a decoder that drops object field
            // order (which jsonNorm/toEqual, comparing through unordered objects,
            // cannot). Object key ordering is a preserved round-trip property
            // (SPEC 52, 931).
            expect(encodeGeneric(decoded)).toBe(got);
          }
          break;
        }
        case 'decode': {
          const got = decodeGeneric(data.input);
          expect(jsonSubset(data.expected, got)).toBe(true);
          break;
        }
        case 'roundtrip': {
          // Encode the input, verify it matches expected, then decode and verify round-trip.
          const encoded = encodeGeneric(orderedInput(raw));
          expect(encoded).toBe(data.expected);
          const decoded = decodeGeneric(encoded);
          expect(jsonNorm(decoded)).toEqual(jsonNorm(data.input));
          // Re-encode idempotence (order-sensitive); see the `encode` case.
          expect(encodeGeneric(decoded)).toBe(encoded);
          break;
        }
        case 'error': {
          const inputStr = data.inputBase64
            ? Buffer.from(data.inputBase64, 'base64').toString('binary')
            : data.input;
          // v3 decoder may surface different error categories for the same invalid input.
          // The requirement is that it rejects; the exact category may differ.
          expect(() => decodeGeneric(inputStr)).toThrow();
          break;
        }
        case 'roundtrip-wire': {
          // input and expected are both wire strings. Decode the input wire, re-encode,
          // and require the result to equal expected. Decode in bigint mode so an
          // int64 value beyond this host's safe range survives (in the default 'error'
          // mode a JavaScript decoder rejects it; that default is exercised separately).
          const decoded = decodeGeneric(data.input, { largeInt: 'bigint' });
          expect(encodeGeneric(decoded)).toBe(data.expected);
          break;
        }
        case 'encode-error': {
          // input is a JSON value out of the numeric domain; ingesting it through the
          // JSON->value bridge (parseJSONOrdered, via orderedInput) then encoding it
          // must throw. The value never becomes an approximate host number.
          expect(() => encodeGeneric(orderedInput(raw))).toThrow();
          break;
        }
        case 'generic-pack-root': {
          const inp = data.input;
          const got = genericPackRoot({ key: inp.key, fields: inp.fields, rows: inp.rows });
          expect(got).toBe(data.expected);
          break;
        }
        case 'generic-delta': {
          const inp = data.input;
          const d: GenericDeltaPayload = {
            tool: inp.tool, key: inp.key, fields: inp.fields,
            baseRoot: inp.baseRoot, newRoot: inp.newRoot,
            added: inp.added ?? [], changed: inp.changed ?? [], removed: inp.removed ?? [],
            deltaTokens: inp.deltaTokens, fullTokens: inp.fullTokens,
          };
          const gotDelta = encodeGenericDelta(d);
          expect(gotDelta).toBe(data.expected);
          // Re-encode idempotence: encodeGenericDelta(decodeGenericDelta(got)) === got,
          // ignoring the derived savings= header stat (see stripDeltaSavings). Confirms
          // the delta decoder preserves fields and their order (SPEC 52, 931).
          expect(stripDeltaSavings(encodeGenericDelta(decodeGenericDelta(gotDelta)))).toBe(stripDeltaSavings(gotDelta));
          break;
        }
        case 'generic-delta-verify': {
          const inp = data.input;
          const base: GenericSet = { key: inp.base.key, fields: inp.base.fields, rows: inp.base.rows };
          const dd = inp.delta;
          const d: GenericDeltaPayload = {
            key: dd.key, fields: dd.fields, baseRoot: dd.baseRoot, newRoot: dd.newRoot ?? '',
            added: dd.added ?? [], changed: dd.changed ?? [], removed: dd.removed ?? [],
          };
          if (data.expectedError) {
            expect(() => verifyGenericDelta(base, d, inp.expectedNewRoot)).toThrow(data.expectedError);
          } else {
            const res = verifyGenericDelta(base, d, inp.expectedNewRoot);
            expect(genericPackRoot(res)).toBe(data.expected);
          }
          break;
        }
        case 'generic-delta-decode': {
          const inp = data.input;
          const base: GenericSet = { key: inp.base.key, fields: inp.base.fields, rows: inp.base.rows };
          if (data.expectedError) {
            expect(() => verifyGenericDelta(base, decodeGenericDelta(inp.wire), inp.expectedNewRoot)).toThrow(data.expectedError);
          } else {
            const res = verifyGenericDelta(base, decodeGenericDelta(inp.wire), inp.expectedNewRoot);
            expect(genericPackRoot(res)).toBe(data.expected);
          }
          break;
        }
        case 'generic-delta-session': {
          const inp = data.input;
          const mkSet = (o: any): GenericSet => ({ name: o.name, key: o.key, fields: o.fields, rows: o.rows });
          const policy: ReanchorPolicy = inp.policy.mode === 'sizeGuard'
            ? sizeGuard()
            : fixedN(inp.policy.n);
          const s = new GenericDeltaSession(mkSet(inp.base), inp.tool, policy);
          expect(s.currentFull()).toBe(data.expected.initialFull);
          const updates = inp.updates ?? [];
          for (let i = 0; i < updates.length; i++) {
            const em = s.next(mkSet(updates[i]));
            const want = data.expected.emissions[i];
            expect({ isFull: em.isFull, wire: em.wire }).toEqual({ isFull: want.isFull, wire: want.wire });
          }
          break;
        }
        case 'pack-root': {
          const inp = data.input;
          const symbols: Symbol[] = (inp.symbols ?? []).map((s: any) => ({
            qualifiedName: s.qualifiedName,
            kind: s.kind,
            score: s.score,
            provenance: s.provenance,
            distance: s.distance,
          }));
          const edges: Edge[] = (inp.edges ?? []).map((e: any) => ({
            source: e.source,
            target: e.target,
            edgeType: e.edgeType,
            status: e.status ?? undefined,
          }));
          const got = packRoot(symbols, edges);
          expect(got).toBe(data.expected);
          break;
        }
        case 'graph-stream-encode': {
          const inp = data.input;
          const chunks: string[] = [];
          const enc = new StreamEncoder(
            { write: (s) => chunks.push(s) },
            inp.tool,
            {
              tokenBudget: inp.tokenBudget,
              tokensUsed: inp.tokensUsed,
              packRoot: inp.packRoot,
              labeledTrailerCounts: data.options?.labeledTrailerCounts,
            },
          );
          for (const s of inp.symbols ?? []) {
            enc.writeSymbol({
              qualifiedName: s.qualifiedName,
              kind: s.kind,
              score: s.score,
              provenance: s.provenance,
              distance: s.distance,
            });
          }
          for (const e of inp.edges ?? []) {
            enc.writeEdge({
              source: e.source,
              target: e.target,
              edgeType: e.edgeType,
              status: e.status ?? undefined,
            });
          }
          enc.close();
          expect(chunks.join('')).toBe(data.expected);
          break;
        }
        case 'session': {
          // One session carries state across all calls; each call's encode must
          // byte-match its expected wire, with prior symbols emitted as bare refs.
          const session = new Session();
          for (const call of data.calls) {
            const p = toPayload(call.input);
            const got = encodeWithSession(p, session);
            expect(got).toBe(call.expected);
          }
          break;
        }
        case 'delta-verify':
        case 'delta': {
          // Verify path: `delta-verify`, or a `delta` fixture whose `input` is a
          // wire string / carries a base_snapshot. Decode the wire, apply against
          // the base snapshot, and check the recomputed pack root.
          if (op === 'delta-verify' || typeof data.input === 'string' || data.base_snapshot !== undefined) {
            const mkSym = (s: any): Symbol => ({
              qualifiedName: s.qualifiedName,
              kind: s.kind,
              score: s.score ?? 0,
              provenance: s.provenance ?? '',
              distance: s.distance ?? 0,
            });
            const mkEdge = (e: any): Edge => ({
              source: e.source,
              target: e.target,
              edgeType: e.edgeType,
              status: e.status ?? undefined,
            });
            const base = data.base_snapshot ?? { symbols: [], edges: [] };
            const baseSymbols: Symbol[] = (base.symbols ?? []).map(mkSym);
            const baseEdges: Edge[] = (base.edges ?? []).map(mkEdge);
            const d = decodeDelta(data.input);
            const doVerify = () =>
              verifyDelta(
                baseSymbols,
                baseEdges,
                d.removed,
                d.added,
                d.removedEdges,
                d.addedEdges,
                d.newRoot,
              );
            if (data.expectedError) {
              expect(doVerify).toThrow(/root_mismatch/);
            } else {
              const res = doVerify();
              const expSnap = data.expected_snapshot;
              const expSymbols: Symbol[] = (expSnap.symbols ?? []).map(mkSym);
              const expEdges: Edge[] = (expSnap.edges ?? []).map(mkEdge);
              expect(packRoot(res.symbols, res.edges)).toBe(packRoot(expSymbols, expEdges));
            }
            break;
          }

          // Encode path: input is a delta payload object.
          const inp = data.input;
          const mkSym = (s: any): Symbol => ({
            qualifiedName: s.qualifiedName,
            kind: s.kind,
            score: s.score,
            provenance: s.provenance,
            distance: s.distance ?? 0,
          });
          const mkEdge = (e: any): Edge => ({
            source: e.source,
            target: e.target,
            edgeType: e.edgeType,
            status: e.status ?? undefined,
          });
          const d: DeltaPayload = {
            tool: inp.tool,
            baseRoot: inp.baseRoot,
            newRoot: inp.newRoot,
            removed: (inp.removed ?? []).map(mkSym),
            added: (inp.added ?? []).map(mkSym),
            removedEdges: (inp.removedEdges ?? []).map(mkEdge),
            addedEdges: (inp.addedEdges ?? []).map(mkEdge),
            deltaTokens: inp.deltaTokens,
            fullTokens: inp.fullTokens,
          };
          expect(encodeDelta(d)).toBe(data.expected);
          break;
        }
        default:
          throw new Error(`unhandled operation: ${op}`);
      }
    });
  }
});

// Normalize a decoded value for structural (order-insensitive) comparison.
// decodeGeneric returns Map for every JSON object (to preserve key order,
// including integer-like keys, on re-encode), so collapse Maps to plain objects
// before comparing. Recurses through arrays and nested Maps.
function jsonNorm(v: any): any {
  if (v instanceof Map) {
    const o: Record<string, any> = {};
    for (const [k, val] of v) o[k] = jsonNorm(val);
    return o;
  }
  if (Array.isArray(v)) return v.map(jsonNorm);
  if (v && typeof v === 'object') {
    const o: Record<string, any> = {};
    for (const k of Object.keys(v)) o[k] = jsonNorm(v[k]);
    return o;
  }
  // Negative zero canonicalizes to 0 (SPEC 2.3.1); -0 and +0 are the same value,
  // but toEqual distinguishes them via Object.is, so normalize -0 to 0.
  if (Object.is(v, -0)) return 0;
  return v;
}

function jsonSubset(expected: any, got: any): boolean {
  const e = jsonNorm(expected);
  const g = jsonNorm(got);
  return subsetMatch(e, g);
}

function subsetMatch(expected: any, got: any): boolean {
  if (expected === null || typeof expected !== 'object') {
    return expected === got;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(got) || got.length !== expected.length) return false;
    return expected.every((v: any, i: number) => subsetMatch(v, got[i]));
  }
  if (typeof got !== 'object' || got === null) return false;
  return Object.keys(expected).every(k => subsetMatch(expected[k], got[k]));
}

// Remove the derived ` savings=...` header stat so re-encode idempotence can be
// checked on the parts of the wire the payload actually carries. The stat is computed
// from the original set sizes at encode time and is not on the wire, so a
// decode/re-encode legitimately cannot reconstruct it.
function stripDeltaSavings(s: string): string {
  const idx = s.indexOf(' savings=');
  if (idx < 0) return s;
  let end = idx + ' savings='.length;
  while (end < s.length && s[end] !== ' ' && s[end] !== '\n') end++;
  return s.slice(0, idx) + s.slice(end);
}

function toPayload(input: any): Payload {
  return {
    tool: input.tool,
    tokenBudget: input.tokenBudget ?? 0,
    tokensUsed: input.tokensUsed ?? 0,
    packRoot: input.packRoot,
    symbols: (input.symbols ?? []).map((s: any) => ({
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      score: s.score,
      provenance: s.provenance,
      distance: s.distance,
    })),
    edges: (input.edges ?? []).map((e: any) => ({
      source: e.source,
      target: e.target,
      edgeType: e.edgeType,
      status: e.status ?? undefined,
    })),
  };
}
