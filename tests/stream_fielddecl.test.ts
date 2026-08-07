import { describe, it, expect } from 'vitest';
import { GenericStreamEncoder, decodeGeneric } from '../src/index.js';

// Fuzz the streaming tabular header field-declaration quoting (SPEC 8.3).
// The streaming header must quote section and field names the same way the
// buffered tabular header does, so adversarial field names (containing a
// comma, pipe, quote, etc.) round-trip cleanly rather than splitting the
// schema or producing an invalid header.

const ITERATIONS = parseInt(process.env.GCF_ITERATIONS ?? '200000', 10);

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

// Field-name character pool. Deliberately includes delimiters and quote-forcing
// characters (comma, pipe, quote, spaces, leading @/#/.), but NOT '>' (a flattened
// path is not representable in a streaming row and is rejected separately below).
const FIELD_CHARS = 'abcXYZ012 _,|"@#.=~^+-';

function genFieldName(rng: () => number): string {
  const n = randInt(rng, 8); // 0..7, allows the empty string
  let s = '';
  for (let i = 0; i < n; i++) s += FIELD_CHARS[randInt(rng, FIELD_CHARS.length)];
  return s;
}

// Distinct field names: the decoder rejects duplicate field names, and duplicate
// keys would collide in the decoded object. Suffix collisions to keep them unique
// without perturbing the adversarial character distribution.
function genFields(rng: () => number): string[] {
  const count = 1 + randInt(rng, 6);
  const fields: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < count; i++) {
    let name = genFieldName(rng);
    while (seen.has(name)) name += FIELD_CHARS[randInt(rng, FIELD_CHARS.length)];
    seen.add(name);
    fields.push(name);
  }
  return fields;
}

function genScalar(rng: () => number): unknown {
  switch (randInt(rng, 5)) {
    case 0: return null;
    case 1: return rng() < 0.5;
    case 2: return randInt(rng, 100000) - 50000;
    case 3: return randInt(rng, 1000) + rng();
    default: {
      // A row value that itself needs quoting exercises the value path too.
      const pool = 'abc012 |,"@#';
      const n = randInt(rng, 6);
      let s = '';
      for (let i = 0; i < n; i++) s += pool[randInt(rng, pool.length)];
      return s;
    }
  }
}

function needsQuoteName(s: string): boolean {
  // Any name a bare key cannot represent must be quoted in the header.
  return !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(s);
}

function collect(): { writer: { write: (s: string) => void }; output: () => string } {
  const chunks: string[] = [];
  return {
    writer: { write: (s: string) => chunks.push(s) },
    output: () => chunks.join(''),
  };
}

describe('GenericStreamEncoder field-declaration quoting fuzz', () => {
  it('round-trips adversarial field names and quoted section names', () => {
    const rng = makeRng(0x5f3759df);
    let sawQuotedField = false;
    let failures = 0;
    let firstFailure = '';

    for (let iter = 0; iter < ITERATIONS; iter++) {
      const fields = genFields(rng);
      if (fields.some(needsQuoteName)) sawQuotedField = true;

      // Section name is also fed through the same quoting path; vary it too.
      const sectionName = rng() < 0.5 ? 'rows' : genFieldName(rng) || 'rows';

      const rowCount = 1 + randInt(rng, 4);
      const rows: unknown[][] = [];
      for (let r = 0; r < rowCount; r++) {
        rows.push(fields.map(() => genScalar(rng)));
      }

      const { writer, output } = collect();
      const enc = new GenericStreamEncoder(writer);
      enc.beginArray(sectionName, fields);
      for (const row of rows) enc.writeRow(row);
      enc.endArray();
      enc.close();

      // The encoder emits the profile line itself; decode the output as-is.
      const wire = output();
      const decoded = decodeGeneric(wire);

      const expected = rows.map((row) => {
        const obj: Record<string, unknown> = {};
        fields.forEach((f, i) => { obj[f] = row[i]; });
        return obj;
      });

      const actual = decoded[sectionName];
      if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        if (failures === 0) {
          firstFailure =
            `iter=${iter} section=${JSON.stringify(sectionName)} fields=${JSON.stringify(fields)}\n` +
            `wire=${JSON.stringify(wire)}\n` +
            `expected=${JSON.stringify(expected)}\nactual=${JSON.stringify(actual)}`;
        }
        failures++;
      }
    }

    expect(failures, firstFailure).toBe(0);
    // Liveness: the generator must have produced at least one field name that
    // required quoting, otherwise the test would pass trivially.
    expect(sawQuotedField).toBe(true);
  });

  it('rejects a field name containing ">" at close()', () => {
    const { writer } = collect();
    const enc = new GenericStreamEncoder(writer);
    // A flattened path is not representable in a flat streaming row (SPEC 8.3).
    enc.beginArray('rows', ['id', 'customer>name']);
    enc.writeRow([1, 'Alice']);
    enc.endArray();
    expect(() => enc.close()).toThrow(/'>'/);
  });
});
