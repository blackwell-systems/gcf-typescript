import { describe, it, expect } from 'vitest';
import { encodeGeneric, decodeGeneric } from '../src/index.js';

function jsonNorm(v: any): any {
  return JSON.parse(JSON.stringify(v));
}

// Seeded PRNG (mulberry32)
function mulberry32(seed: number) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Bracket-colon quoting: adversarial strings', () => {
  const adversarial = [
    // Basic patterns
    'ERR[404]: Not Found',
    '[Speaker 1]: Hello',
    '[0]: looks like array',
    '[100]: big number',
    '[abc]: non-numeric',
    '[-1]: negative',

    // Brackets without colon (should NOT need quoting for this rule)
    'value[0] ok',
    'array[10]',
    'test[foo]bar',
    '[just brackets]',

    // Colon without brackets (should NOT need quoting for this rule)
    'key: value',
    'has:colon',
    'http://example.com',
    '00:01:23',

    // Multiple patterns in one string
    'ERR[404]: Not Found and [500]: Server Error',
    '[a]: first [b]: second',
    'nested[0]: outer[1]: inner',

    // Edge cases: empty brackets
    '[]: empty',
    '[]:: double colon',

    // Brackets with spaces
    '[ 0 ]: spaced',
    '[  ]: just spaces',
    '[ Speaker 1 ]: spaced speaker',

    // Nested brackets
    '[[0]]: nested',
    '[arr[0]]: complex',
    'data[[key]]: deep',

    // Brackets at start, middle, end
    '[0]: at start',
    'middle [0]: here',
    'at end [0]:',
    'at end [0]: ',

    // Combined with other special chars
    '[0]: has "quotes"',
    '[0]: has \\backslash',
    '[0]: has\nnewline',
    '[0]: has\ttab',
    '"[0]: already quoted"',
    '[0]: with, comma',
    '[0]: with| pipe',

    // Real-world patterns
    'ERROR[ENOENT]: File not found',
    'WARNING[deprecated]: Use v2 API',
    'LOG[2026-06-18T10:30:00Z]: Server started',
    'METRIC[cpu.usage]: 73.2%',
    'ICD-10[J06.9]: Acute upper respiratory infection',
    'port[443]: HTTPS',
    'config[database.host]: localhost',
    'env[NODE_ENV]: production',
    'ref[HEAD~3]: abc1234',
    'tag[v2.1.0]: release',
    'slot[0]: empty',
    'index[99]: last',
    'field[name]: John',
  ];

  it('all adversarial strings survive round-trip as object values', () => {
    for (const s of adversarial) {
      const obj = { value: s };
      const encoded = encodeGeneric(obj);
      const decoded = decodeGeneric(encoded);
      expect(jsonNorm(decoded)).toEqual(jsonNorm(obj));
    }
  });

  it('all adversarial strings survive round-trip as nested values', () => {
    for (const s of adversarial) {
      const obj = { outer: { inner: s } };
      const encoded = encodeGeneric(obj);
      const decoded = decodeGeneric(encoded);
      expect(jsonNorm(decoded)).toEqual(jsonNorm(obj));
    }
  });

  it('all adversarial strings survive round-trip in arrays', () => {
    const obj = { items: adversarial };
    const encoded = encodeGeneric(obj);
    const decoded = decodeGeneric(encoded);
    expect(jsonNorm(decoded)).toEqual(jsonNorm(obj));
  });

  it('all adversarial strings survive round-trip as tabular rows', () => {
    const rows = adversarial.map((s, i) => ({ id: i, text: s }));
    const obj = { rows };
    const encoded = encodeGeneric(obj);
    const decoded = decodeGeneric(encoded);
    expect(jsonNorm(decoded)).toEqual(jsonNorm(obj));
  });
});

describe('Bracket-colon quoting: generated edge cases', () => {
  const brackets = ['[', '[[', '[0', '[abc', '[ ', '[0]', '[abc]', '[ 0 ]', '[]', '[-1]'];
  const afterBracket = [':', ': ', ':value', ': value', ':\n', ':,', ':|'];
  const prefixes = ['', 'key', 'ERR', 'a.b', '"quoted"'];
  const suffixes = ['', ' rest', ' more text', ',next'];

  it('all bracket+colon combinations survive round-trip', () => {
    let count = 0;
    for (const prefix of prefixes) {
      for (const bracket of brackets) {
        for (const after of afterBracket) {
          for (const suffix of suffixes) {
            const s = `${prefix}${bracket}${after}${suffix}`;
            // Skip strings with actual newlines in this test (they get quoted for other reasons)
            if (s.includes('\n')) continue;
            const obj = { val: s };
            try {
              const encoded = encodeGeneric(obj);
              const decoded = decodeGeneric(encoded);
              expect(jsonNorm(decoded)).toEqual(jsonNorm(obj));
              count++;
            } catch (e: any) {
              throw new Error(`Failed on: ${JSON.stringify(s)}\n${e.message}`);
            }
          }
        }
      }
    }
    expect(count).toBeGreaterThan(500);
  });
});

describe('Bracket-colon quoting: 1M fuzz iterations', () => {
  it('100000000 random strings with brackets and colons survive round-trip', () => {
    const rng = mulberry32(42);
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789 _-.[]{}():=|,\'"\\/@#';
    let pass = 0;
    let fail = 0;
    const failures: string[] = [];

    for (let i = 0; i < 100000000; i++) {
      // Generate random string with bias toward bracket/colon characters
      const len = 1 + Math.floor(rng() * 40);
      let s = '';
      for (let j = 0; j < len; j++) {
        s += chars[Math.floor(rng() * chars.length)];
      }

      const obj = { v: s };
      try {
        const encoded = encodeGeneric(obj);
        const decoded = decodeGeneric(encoded);
        if (JSON.stringify(jsonNorm(decoded)) === JSON.stringify(jsonNorm(obj))) {
          pass++;
        } else {
          fail++;
          if (failures.length < 10) {
            failures.push(`Mismatch: ${JSON.stringify(s)} -> ${JSON.stringify(decoded)}`);
          }
        }
      } catch (e: any) {
        fail++;
        if (failures.length < 10) {
          failures.push(`Error on ${JSON.stringify(s)}: ${e.message.slice(0, 100)}`);
        }
      }
    }

    if (failures.length > 0) {
      console.log('Sample failures:');
      failures.forEach(f => console.log(f));
    }

    expect(fail).toBe(0);
    expect(pass).toBe(100000000);
  });
}, 600000);
