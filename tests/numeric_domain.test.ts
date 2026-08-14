import { describe, it, expect } from 'vitest';
import { decodeGeneric, encodeGeneric, parseJSONOrdered } from '../src/index.js';

// JavaScript-local numeric-domain behavior (SPEC 2.3.2). The shared conformance suite
// runs the wire-idempotence fixtures in bigint mode; these tests pin the JS-specific
// largeInt policy (the 2^53 boundary, both signs) and the encode-side bigint domain,
// which no cross-SDK fixture can express because only this host reaches 2^53.

const wire = (digits: string) => `GCF profile=generic\nv=${digits}\n`;
const PAST_SAFE = '9007199254740993'; // 2^53 + 1, in-domain, beyond the safe range
const I64_MAX = '9223372036854775807'; // 2^63 - 1
const I64_MIN = '-9223372036854775808'; // -2^63
const OVER_MAX = '9223372036854775808'; // 2^63, out of domain
const UNDER_MIN = '-9223372036854775809'; // -2^63 - 1, out of domain

describe('largeInt decode policy (2^53 boundary)', () => {
  it("defaults to 'error' for an in-domain value beyond 2^53", () => {
    expect(() => decodeGeneric(wire(PAST_SAFE))).toThrow(/unsafe_integer/);
  });

  it("'string' returns the exact digits", () => {
    const m = decodeGeneric(wire(PAST_SAFE), { largeInt: 'string' }) as Map<string, unknown>;
    expect(m.get('v')).toBe(PAST_SAFE);
  });

  it("'bigint' returns an exact bigint, at both int64 edges", () => {
    expect((decodeGeneric(wire(PAST_SAFE), { largeInt: 'bigint' }) as Map<string, unknown>).get('v')).toBe(9007199254740993n);
    expect((decodeGeneric(wire(I64_MAX), { largeInt: 'bigint' }) as Map<string, unknown>).get('v')).toBe(9223372036854775807n);
    expect((decodeGeneric(wire(I64_MIN), { largeInt: 'bigint' }) as Map<string, unknown>).get('v')).toBe(-9223372036854775808n);
  });

  it("'number' returns a (lossy) number", () => {
    const v = (decodeGeneric(wire(PAST_SAFE), { largeInt: 'number' }) as Map<string, unknown>).get('v');
    expect(typeof v).toBe('number');
  });

  it('a safe integer is always a number, regardless of mode', () => {
    expect((decodeGeneric(wire('9007199254740991')) as Map<string, unknown>).get('v')).toBe(9007199254740991);
  });

  it('resets the mode after each decode (no leak across calls)', () => {
    decodeGeneric(wire(PAST_SAFE), { largeInt: 'bigint' });
    expect(() => decodeGeneric(wire(PAST_SAFE))).toThrow(/unsafe_integer/);
  });
});

describe('int64 domain edge (fleet-wide, every mode)', () => {
  for (const mode of ['error', 'string', 'bigint', 'number'] as const) {
    it(`rejects 2^63 and -2^63-1 in '${mode}' mode`, () => {
      expect(() => decodeGeneric(wire(OVER_MAX), { largeInt: mode })).toThrow(/out_of_range/);
      expect(() => decodeGeneric(wire(UNDER_MIN), { largeInt: mode })).toThrow(/out_of_range/);
    });
  }
});

describe('bigint encode', () => {
  it('serializes an int64 bigint to exact digits across the interval', () => {
    expect(encodeGeneric(new Map([['v', 9007199254740993n]]))).toBe(wire(PAST_SAFE));
    expect(encodeGeneric(new Map([['v', 9223372036854775807n]]))).toBe(wire(I64_MAX));
    expect(encodeGeneric(new Map([['v', -9223372036854775808n]]))).toBe(wire(I64_MIN));
  });

  it('rejects a bigint outside int64', () => {
    expect(() => encodeGeneric(new Map([['v', 9223372036854775808n]]))).toThrow(/out_of_range/);
    expect(() => encodeGeneric(new Map([['v', -9223372036854775809n]]))).toThrow(/out_of_range/);
  });

  it('round-trips wire -> bigint -> wire at the int64 edges', () => {
    for (const d of [PAST_SAFE, I64_MAX, I64_MIN]) {
      expect(encodeGeneric(decodeGeneric(wire(d), { largeInt: 'bigint' }))).toBe(wire(d));
    }
  });
});

describe('JSON->value bridge (parseJSONOrdered)', () => {
  it('preserves an int64 literal beyond 2^53 as an exact bigint', () => {
    expect((parseJSONOrdered(`{"v": ${I64_MAX}}`) as Map<string, unknown>).get('v')).toBe(9223372036854775807n);
    expect((parseJSONOrdered(`{"v": ${PAST_SAFE}}`) as Map<string, unknown>).get('v')).toBe(9007199254740993n);
  });

  it('keeps a safe integer a number and an exponent literal a double', () => {
    expect((parseJSONOrdered('{"v": 42}') as Map<string, unknown>).get('v')).toBe(42);
    expect((parseJSONOrdered('{"v": 1e20}') as Map<string, unknown>).get('v')).toBe(1e20);
  });

  it('rejects a bare integer literal outside int64', () => {
    expect(() => parseJSONOrdered(`{"v": ${OVER_MAX}}`)).toThrow(/out_of_range/);
  });
});
