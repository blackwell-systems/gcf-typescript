import { describe, it, expect } from 'vitest';
import {
  genericPackRoot,
  encodeGenericFull,
  decodeGenericFull,
  decodeGenericDelta,
  type GenericSet,
} from '../src/generic_delta.js';

// Fuzz/property tests for generic-profile delta (mirrors gcf-go FuzzGeneric*):
//  A. decode* never crash on arbitrary / mutated input (fail closed).
//  B. arbitrary string cells survive the full-wire round-trip with pack root preserved.

const ALPHABET = [...'abcXYZ0129 .,-~^@#=|\t\n\r"\\/éñ中\u{1f99e}'];

function mkRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randStr(rng: () => number, maxlen = 20): string {
  const n = Math.floor(rng() * (maxlen + 1));
  let out = '';
  for (let i = 0; i < n; i++) out += ALPHABET[Math.floor(rng() * ALPHABET.length)];
  return out;
}

describe('generic-delta fuzz', () => {
  it('string cells round-trip with the pack root preserved', () => {
    const rng = mkRng(1234);
    for (let i = 0; i < 20000; i++) {
      const a = randStr(rng);
      const b = randStr(rng);
      const s: GenericSet = { key: 'id', name: 't', fields: ['id', 'a', 'b'], rows: [{ id: 1, a, b }, { id: 2, a: b, b: a }] };
      const { set } = decodeGenericFull(encodeGenericFull(s, ''));
      expect(genericPackRoot(set)).toBe(genericPackRoot(s));
    }
  });

  it('decode never crashes on arbitrary input', () => {
    const rng = mkRng(99);
    const seeds = [
      'GCF profile=generic delta=true base_root=a new_root=b key=id\n## added [1]{@id,x}\n1|2\n',
      'GCF profile=generic pack_root=r key=id\n## t [2]{@id,x}\n1|2\n3|4\n',
      '## removed [1]{@id}\n99\n',
      '',
    ];
    for (let i = 0; i < 20000; i++) {
      let data: string;
      if (rng() < 0.5) {
        data = randStr(rng, 80);
      } else {
        const chars = [...seeds[Math.floor(rng() * seeds.length)]];
        const m = Math.floor(rng() * 6);
        for (let j = 0; j < m; j++) {
          if (chars.length) chars[Math.floor(rng() * chars.length)] = ALPHABET[Math.floor(rng() * ALPHABET.length)];
        }
        data = chars.join('');
      }
      try { decodeGenericDelta(data); } catch { /* controlled failure is fine */ }
      try { decodeGenericFull(data); } catch { /* controlled failure is fine */ }
    }
  });
});
