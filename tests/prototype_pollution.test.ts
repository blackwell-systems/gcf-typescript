import { describe, it, expect } from 'vitest';
import { encodeGeneric } from '../src/generic.js';
import { decodeGeneric } from '../src/decode_generic.js';

// Prototype-pollution is a JS/TS-specific concern (map-based SDKs are unaffected).
// The generic encoder/decoder must never mutate Object.prototype and must treat
// keys shadowing Object.prototype members as ordinary data.
describe('generic profile — prototype-pollution safety', () => {
  it('round-trips a nested object with a literal __proto__ own-key without polluting', () => {
    const input = [
      JSON.parse('{"id":1,"meta":{"__proto__":{"polluted":true},"real":1}}'),
      JSON.parse('{"id":2,"meta":{"__proto__":{"polluted":true},"real":2}}'),
    ];
    const decoded = decodeGeneric(encodeGeneric(input));
    expect(decoded).toEqual(input);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('round-trips a top-level __proto__ column without polluting', () => {
    const input = [JSON.parse('{"id":1,"__proto__":"x"}'), JSON.parse('{"id":2,"__proto__":"y"}')];
    const decoded = decodeGeneric(encodeGeneric(input));
    expect(decoded).toEqual(input);
    expect(({} as Record<string, unknown>).x).toBeUndefined();
  });

  it('does not pollute or throw when decoding hostile GCF with a >__proto__> path column', () => {
    const hostile = 'GCF profile=generic\n## [1]{id,"a>__proto__>polluted"}\n@0 0|1\n';
    expect(() => decodeGeneric(hostile)).not.toThrow();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it('round-trips keys named toString/constructor/valueOf as own properties', () => {
    const input = [
      { id: 1, toString: 't1', constructor: 'c1', valueOf: 1 },
      { id: 2, toString: 't2', constructor: 'c2', valueOf: 2 },
    ];
    const decoded = decodeGeneric(encodeGeneric(input));
    expect(decoded).toEqual(input);
  });
});
