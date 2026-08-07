import { describe, it, expect } from 'vitest';
import { encodeGeneric, decodeGeneric } from '../src/index.js';

// Property fuzz for keyed-map encoding (SPEC 7.2a), mirroring the gcf-go
// reference. Random maps-of-objects (including adversarial keys and values,
// single-member maps that MUST NOT key, and all-">" value-field maps that MUST
// fall back to section encoding) round-trip via encode -> decode. The decoder is
// always run against the encoder's raw output; a case needing a workaround is a
// bug, not a test detail.

const ALPHABET = [...'abcXYZ0129 .,-~^@#=|:>{}[]"\\/éñ中\u{1f99e}'];
// Field-name alphabet excludes ">" so most generated value objects are tabular
// (a ">"-named value field is exercised separately by the all-">" fallback case).
const FIELD_ALPHABET = [...'abcXYZ0129_key'];

function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randStr(rng: () => number, alphabet: string[], maxlen: number): string {
  const n = Math.floor(rng() * (maxlen + 1));
  let out = '';
  for (let i = 0; i < n; i++) out += alphabet[Math.floor(rng() * alphabet.length)];
  return out;
}

// A random scalar the JSON data model preserves losslessly (no undefined; no
// non-finite numbers).
function randScalar(rng: () => number): unknown {
  const r = rng();
  if (r < 0.15) return null;
  if (r < 0.3) return rng() < 0.5;
  if (r < 0.55) return Math.floor(rng() * 2000) - 1000;
  if (r < 0.65) return Math.round((rng() * 200 - 100) * 100) / 100;
  return randStr(rng, ALPHABET, 8);
}

// A keyed header always renders as `[N:]{` or `[?:]{`. A negative-case wire is
// asserted keyless by scanning for that structural signature; used only where
// value strings are drawn from an alphabet that cannot spoof it.
function hasKeyedHeader(wire: string): boolean {
  return /\[(?:\d+|\?):\]\{/.test(wire);
}

// Build a set of member-value objects sharing a random field union. Field
// presence per member varies (absent fields exercise the ~ path); a present
// field is a scalar so the objects stay losslessly tabular.
function randValueObjects(rng: () => number, memberCount: number): Record<string, unknown>[] {
  const fieldCount = 1 + Math.floor(rng() * 4);
  const fields: string[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (fields.length < fieldCount && guard++ < 50) {
    const f = randStr(rng, FIELD_ALPHABET, 6) || 'f';
    if (!seen.has(f)) { seen.add(f); fields.push(f); }
  }
  const objs: Record<string, unknown>[] = [];
  for (let m = 0; m < memberCount; m++) {
    const o: Record<string, unknown> = {};
    for (const f of fields) {
      // Skip some fields (absent), and guarantee at least the first field so no
      // object is empty (an all-empty union is not keyed by design).
      if (f === fields[0] || rng() < 0.75) o[f] = randScalar(rng);
    }
    if (Object.keys(o).length === 0) o[fields[0]] = randScalar(rng);
    objs.push(o);
  }
  return objs;
}

// A unique member key drawn from the adversarial alphabet (may need quoting).
function randMemberKeys(rng: () => number, count: number): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (keys.length < count && guard++ < 200) {
    const k = randStr(rng, ALPHABET, 6);
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  // Backfill deterministically if the adversarial draw collided too often.
  let i = 0;
  while (keys.length < count) {
    const k = `k${i++}`;
    if (!seen.has(k)) { seen.add(k); keys.push(k); }
  }
  return keys;
}

// Order-insensitive structural equality. Tabular encoding factors a shared
// field union, so a member missing an early field but carrying a later one can
// decode with its own keys in union order rather than source order; SPEC 1.1
// preserves key membership and values, which is what we assert.
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const aArr = Array.isArray(a), bArr = Array.isArray(b);
  if (aArr !== bArr) return false;
  if (aArr) {
    const ar = a as unknown[], br = b as unknown[];
    if (ar.length !== br.length) return false;
    return ar.every((v, i) => deepEqual(v, br[i]));
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every(k => Object.prototype.hasOwnProperty.call(bo, k) && deepEqual(ao[k], bo[k]));
}

describe('keyed-map fuzz', () => {
  it('random maps-of-objects round-trip via encode -> decode', () => {
    const rng = mkRng(20260806);
    for (let i = 0; i < 120000; i++) {
      const memberCount = 2 + Math.floor(rng() * 5); // >= 2 so the map keys
      const keys = randMemberKeys(rng, memberCount);
      const values = randValueObjects(rng, memberCount);
      const map: Record<string, unknown> = {};
      for (let m = 0; m < memberCount; m++) map[keys[m]] = values[m];

      const wire = encodeGeneric(map);
      // A multi-member losslessly-tabular map MUST use the keyed header.
      expect(wire).toContain(':]{');
      const decoded = decodeGeneric(wire);
      expect(deepEqual(decoded, map)).toBe(true);
    }
  });

  it('nested maps-of-objects (wrappers, keyed-map value fields) round-trip', () => {
    const rng = mkRng(7);
    for (let i = 0; i < 60000; i++) {
      const memberCount = 2 + Math.floor(rng() * 3);
      const keys = randMemberKeys(rng, memberCount);
      const values = randValueObjects(rng, memberCount);
      const inner: Record<string, unknown> = {};
      for (let m = 0; m < memberCount; m++) inner[keys[m]] = values[m];

      // Wrap in shapes that exercise the various keyed-map positions.
      const shape = Math.floor(rng() * 3);
      let root: unknown;
      if (shape === 0) {
        // Single-key wrapper: wrapper is NOT keyed (one member); inner is.
        root = { users: inner };
      } else if (shape === 1) {
        // Scalar sibling + a map-valued member.
        root = { title: randStr(rng, ALPHABET, 5), servers: inner };
      } else {
        // A map whose value objects each carry a keyed-map value field.
        const outerKeys = randMemberKeys(rng, 2);
        root = {
          [outerKeys[0]]: { name: 'g1', members: inner },
          [outerKeys[1]]: { name: 'g2', members: { [keys[0]]: values[0] } },
        };
      }
      const wire = encodeGeneric(root);
      const decoded = decodeGeneric(wire);
      expect(deepEqual(decoded, root)).toBe(true);
    }
  });

  it('single-member maps do NOT key; they round-trip as sections', () => {
    const rng = mkRng(31337);
    for (let i = 0; i < 20000; i++) {
      const key = randStr(rng, FIELD_ALPHABET, 6) || 'k';
      const value = randValueObjects(rng, 1)[0];
      const map: Record<string, unknown> = { [key]: value };
      const wire = encodeGeneric(map);
      // A one-member map must never produce a keyed header (SPEC 7.2a.1 clause 1).
      // Values here are drawn from a safe alphabet so no cell can spoof the header.
      expect(hasKeyedHeader(wire)).toBe(false);
      const decoded = decodeGeneric(wire);
      expect(deepEqual(decoded, map)).toBe(true);
    }
  });

  it('maps whose value fields all contain ">" fall back to section encoding', () => {
    const rng = mkRng(9001);
    for (let i = 0; i < 20000; i++) {
      const memberCount = 2 + Math.floor(rng() * 3);
      const keys: string[] = [];
      const seen = new Set<string>();
      while (keys.length < memberCount) {
        const k = randStr(rng, FIELD_ALPHABET, 6) || `k${keys.length}`;
        if (!seen.has(k)) { seen.add(k); keys.push(k); }
      }
      const map: Record<string, unknown> = {};
      for (let m = 0; m < memberCount; m++) {
        map[keys[m]] = { 'x>y': randScalar(rng), 'a>b>c': randScalar(rng) };
      }
      const wire = encodeGeneric(map);
      // All value fields contain ">" so no tabular column exists: NOT keyed
      // (SPEC 7.2a.1 clause 4 / 7.4.6.1.4).
      expect(hasKeyedHeader(wire)).toBe(false);
      const decoded = decodeGeneric(wire);
      expect(deepEqual(decoded, map)).toBe(true);
    }
  });
});
