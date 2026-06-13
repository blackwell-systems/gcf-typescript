import { describe, it, expect } from 'vitest';
import { encode } from '../src/encode.js';
import { decode } from '../src/decode.js';
import { encodeGeneric, decodeGeneric } from '../src/index.js';

const ITERATIONS = parseInt(process.env.GCF_ITERATIONS ?? '100000', 10);

// Seeded PRNG (xorshift32) for reproducibility.
function makeRng(seed: number) {
  let s = seed;
  return () => {
    s ^= s << 13;
    s ^= s >> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

function randInt(rng: () => number, max: number): number {
  return Math.floor(rng() * max);
}

function pick<T>(rng: () => number, arr: T[]): T {
  return arr[randInt(rng, arr.length)];
}

// --- Generators ---

function genValue(rng: () => number, depth: number, maxDepth: number): any {
  if (depth >= maxDepth) return genScalar(rng);
  switch (randInt(rng, 10)) {
    case 0: return null;
    case 1: return rng() < 0.5;
    case 2: return genNumber(rng);
    case 3: case 4: return genString(rng);
    case 5: case 6: return genObject(rng, depth, maxDepth);
    case 7: case 8: return genArray(rng, depth, maxDepth);
    default: return genScalar(rng);
  }
}

function genScalar(rng: () => number): any {
  switch (randInt(rng, 5)) {
    case 0: return null;
    case 1: return rng() < 0.5;
    case 2: return genNumber(rng);
    default: return genString(rng);
  }
}

function genNumber(rng: () => number): number {
  switch (randInt(rng, 7)) {
    case 0: return 0;
    case 1: return randInt(rng, 1000);
    case 2: return -randInt(rng, 1000);
    case 3: return randInt(rng, 1000000) + rng();
    case 4: return -0;
    case 5: return (randInt(rng, 999) + 1) * 1e18;
    case 6: return (randInt(rng, 999) + 1) * 1e-10;
    default: return rng() * 2000 - 1000;
  }
}

const CHARS = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const SPECIAL = ' |,="\\#@\n\t~^+-.';

function genString(rng: () => number): string {
  const n = randInt(rng, 20);
  let s = '';
  for (let i = 0; i < n; i++) {
    if (rng() < 0.2) {
      s += SPECIAL[randInt(rng, SPECIAL.length)];
    } else {
      s += CHARS[randInt(rng, CHARS.length)];
    }
  }
  return s;
}

function genBareKey(rng: () => number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz_';
  const n = 1 + randInt(rng, 8);
  let s = '';
  for (let i = 0; i < n; i++) s += chars[randInt(rng, chars.length)];
  return s;
}

function genObject(rng: () => number, depth: number, maxDepth: number): Record<string, any> {
  const n = randInt(rng, 6);
  const obj: Record<string, any> = {};
  for (let i = 0; i < n; i++) {
    const key = genBareKey(rng);
    if (!(key in obj)) obj[key] = genValue(rng, depth + 1, maxDepth);
  }
  return obj;
}

function genArray(rng: () => number, depth: number, maxDepth: number): any[] {
  const n = randInt(rng, 6);
  const arr: any[] = [];
  switch (randInt(rng, 4)) {
    case 0:
      for (let i = 0; i < n; i++) arr.push(genScalar(rng));
      break;
    case 1: {
      const fields = Array.from({ length: 1 + randInt(rng, 4) }, () => genBareKey(rng));
      for (let i = 0; i < n; i++) {
        const obj: Record<string, any> = {};
        for (const f of fields) {
          if (rng() > 0.2) obj[f] = genScalar(rng);
        }
        arr.push(obj);
      }
      break;
    }
    case 2:
      for (let i = 0; i < n; i++) {
        const obj: Record<string, any> = {};
        obj[genBareKey(rng)] = genScalar(rng);
        if (rng() < 0.3 && depth + 1 < maxDepth) {
          obj[genBareKey(rng)] = genValue(rng, depth + 2, maxDepth);
        }
        arr.push(obj);
      }
      break;
    default:
      for (let i = 0; i < n; i++) arr.push(genValue(rng, depth + 1, maxDepth));
  }
  return arr;
}

const COLLISION_STRINGS = [
  'true', 'false', '-', '~', '^',
  '0', '1', '42', '-1', '3.14', '1e10', '-0',
  '', ' ', '  ', ' x', 'x ',
  '#', '# comment', '@0', '@handle',
  '+1', '.5', '+.3', '01', '00',
  'null', 'NULL', 'True', 'False',
  '|', ',', '=', '"', '\\',
  '\n', '\r', '\t', '\b',
  'a|b', 'a,b', 'a=b', 'hello world',
];

function genAdversarialScalar(rng: () => number): any {
  switch (randInt(rng, 6)) {
    case 0: return null;
    case 1: return rng() < 0.5;
    case 2: return genNumber(rng);
    default: return rng() < 0.3 ? pick(rng, COLLISION_STRINGS) : genString(rng);
  }
}

function genAdversarialValue(rng: () => number, depth: number, maxDepth: number): any {
  if (depth >= maxDepth) return genAdversarialScalar(rng);
  switch (randInt(rng, 8)) {
    case 0: return null;
    case 1: return rng() < 0.5;
    case 2: return genNumber(rng);
    case 3: return rng() < 0.3 ? pick(rng, COLLISION_STRINGS) : genString(rng);
    case 4: return genAdversarialObject(rng, depth, maxDepth);
    case 5: return genAdversarialArray(rng, depth, maxDepth);
    case 6: return rng() < 0.5 ? {} : [];
    default: return genAdversarialScalar(rng);
  }
}

function genAdversarialObject(rng: () => number, depth: number, maxDepth: number): Record<string, any> {
  const n = randInt(rng, 5);
  const obj: Record<string, any> = {};
  for (let i = 0; i < n; i++) {
    const key = rng() < 0.25 ? pick(rng, COLLISION_STRINGS) : genBareKey(rng);
    if (!(key in obj)) obj[key] = genAdversarialValue(rng, depth + 1, maxDepth);
  }
  return obj;
}

function genAdversarialArray(rng: () => number, depth: number, maxDepth: number): any[] {
  const n = randInt(rng, 5);
  const arr: any[] = [];
  switch (randInt(rng, 5)) {
    case 0:
      for (let i = 0; i < n; i++) arr.push(genAdversarialScalar(rng));
      break;
    case 1: {
      const fields = [genBareKey(rng), genBareKey(rng), genBareKey(rng)];
      for (let i = 0; i < n; i++) {
        const obj: Record<string, any> = {};
        for (const f of fields) {
          switch (randInt(rng, 4)) {
            case 0: break;
            case 1: obj[f] = null; break;
            default: obj[f] = genAdversarialScalar(rng);
          }
        }
        arr.push(obj);
      }
      break;
    }
    case 2:
      for (let i = 0; i < n; i++) {
        const obj: Record<string, any> = {};
        obj[genBareKey(rng)] = genAdversarialScalar(rng);
        if (rng() < 0.5 && depth + 1 < maxDepth) {
          const nested: Record<string, any> = {};
          nested[genBareKey(rng)] = genAdversarialScalar(rng);
          obj[genBareKey(rng)] = nested;
        }
        if (rng() < 0.3) obj[genBareKey(rng)] = [genAdversarialScalar(rng)];
        arr.push(obj);
      }
      break;
    case 3:
      for (let i = 0; i < n; i++) {
        const inner: any[] = [];
        for (let j = 0; j < randInt(rng, 3); j++) inner.push(genAdversarialScalar(rng));
        arr.push(inner);
      }
      break;
    default:
      for (let i = 0; i < n; i++) arr.push(genAdversarialValue(rng, depth + 1, maxDepth));
  }
  return arr;
}

function jsonNorm(v: any): any {
  return JSON.parse(JSON.stringify(v));
}

// Structural deep equality: same types, same values, same array order.
// Object key order is NOT compared (tabular encoding normalizes key order to field union).
function structuralEqual(a: any, b: any): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return Object.is(a, b);
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    if (a.length !== b.length) return false;
    return a.every((v: any, i: number) => structuralEqual(v, b[i]));
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  if (aKeys.join(',') !== bKeys.join(',')) return false;
  return aKeys.every(k => structuralEqual(a[k], b[k]));
}

// --- Graph round-trip (existing) ---

describe('Graph round-trip', () => {
  it('encode then decode preserves payload', () => {
    const p = {
      tool: 'test',
      tokenBudget: 5000,
      tokensUsed: 1847,
      symbols: [
        { qualifiedName: 'pkg.Auth', kind: 'function', score: 0.78, provenance: 'lsp_resolved', distance: 0 },
        { qualifiedName: 'pkg.Server', kind: 'function', score: 0.54, provenance: 'lsp_resolved', distance: 1 },
      ],
      edges: [
        { source: 'pkg.Server', target: 'pkg.Auth', edgeType: 'calls' },
      ],
    };
    const encoded = encode(p);
    const decoded = decode(encoded);
    expect(decoded.tool).toBe(p.tool);
    expect(decoded.symbols.length).toBe(2);
    expect(decoded.edges.length).toBe(1);
  });
});

// --- Generic property-based round-trip ---

describe('Generic property-based round-trip', () => {
  it(`${ITERATIONS} random values`, () => {
    const rng = makeRng(42);
    let failures = 0;
    for (let i = 0; i < ITERATIONS; i++) {
      const val = genValue(rng, 0, 4);
      const gcf = encodeGeneric(val);
      let decoded: any;
      try {
        decoded = decodeGeneric(gcf);
      } catch (e: any) {
        throw new Error(`iteration ${i}: decode failed: ${e.message}\n  input: ${JSON.stringify(val)}\n  gcf: ${JSON.stringify(gcf)}`);
      }
      if (!structuralEqual(jsonNorm(val), jsonNorm(decoded))) {
        throw new Error(`iteration ${i}: round-trip mismatch\n  input:   ${JSON.stringify(val)}\n  decoded: ${JSON.stringify(decoded)}\n  gcf: ${JSON.stringify(gcf)}`);
      }
    }
  });

  it(`${ITERATIONS} adversarial values`, () => {
    const rng = makeRng(99);
    for (let i = 0; i < ITERATIONS; i++) {
      const val = genAdversarialValue(rng, 0, 3);
      const gcf = encodeGeneric(val);
      let decoded: any;
      try {
        decoded = decodeGeneric(gcf);
      } catch (e: any) {
        throw new Error(`iteration ${i}: decode failed: ${e.message}\n  input: ${JSON.stringify(val)}\n  gcf: ${JSON.stringify(gcf)}`);
      }
      if (!structuralEqual(jsonNorm(val), jsonNorm(decoded))) {
        throw new Error(`iteration ${i}: round-trip mismatch\n  input:   ${JSON.stringify(val)}\n  decoded: ${JSON.stringify(decoded)}\n  gcf: ${JSON.stringify(gcf)}`);
      }
    }
  });
});
