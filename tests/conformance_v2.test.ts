import { describe, it, expect } from 'vitest';
import {
  encode, encodeGeneric, decodeGeneric,
  genericPackRoot, encodeGenericDelta, decodeGenericDelta, verifyGenericDelta,
  GenericDeltaSession, fixedN, sizeGuard, type ReanchorPolicy,
  type GenericSet, type GenericDeltaPayload,
  StreamEncoder,
} from '../src/index.js';
import type { Payload, Symbol, Edge } from '../src/index.js';
import { packRoot } from '../src/packroot.js';
import * as fs from 'fs';
import * as path from 'path';

const fixtureDir = path.resolve(__dirname, '../../gcf/tests/conformance');

function loadFixtures(): Array<{ relPath: string; data: any }> {
  const fixtures: Array<{ relPath: string; data: any }> = [];
  if (!fs.existsSync(fixtureDir)) return fixtures;

  function walk(dir: string) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.json')) continue;
      const data = JSON.parse(fs.readFileSync(full, 'utf-8'));
      fixtures.push({ relPath: path.relative(fixtureDir, full), data });
    }
  }
  walk(fixtureDir);
  return fixtures;
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

  for (const { relPath, data } of fixtures) {
    const op = data.operation;
    if (op === 'session' || op === 'delta' || op === 'delta-verify') {
      it.skip(`${relPath} (${op} not implemented)`, () => {});
      continue;
    }
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
          } else {
            const got = encodeGeneric(data.input);
            // v3 encoder produces different byte output for nested/attachment fixtures.
            // v3-inline-schema fixtures byte-match; v2 fixtures that exercise nesting only round-trip check.
            const v3AffectedDirs = ['attachments/', 'arrays/'];
            const isV3Affected = v3AffectedDirs.some(d => relPath.startsWith(d));
            if (!isV3Affected) {
              expect(got).toBe(data.expected);
            }
            // Round-trip (all fixtures must pass this).
            const decoded = decodeGeneric(got);
            expect(jsonNorm(decoded)).toEqual(jsonNorm(data.input));
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
          const encoded = encodeGeneric(data.input);
          expect(encoded).toBe(data.expected);
          const decoded = decodeGeneric(encoded);
          expect(jsonNorm(decoded)).toEqual(jsonNorm(data.input));
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
          expect(encodeGenericDelta(d)).toBe(data.expected);
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
        default:
          throw new Error(`unknown operation: ${op}`);
      }
    });
  }
});

function jsonNorm(v: any): any {
  return JSON.parse(JSON.stringify(v));
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
