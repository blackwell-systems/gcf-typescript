import { describe, it, expect } from 'vitest';
import { encodeGeneric } from '../src/generic.js';
import { decodeGeneric } from '../src/decode_generic.js';

describe('encodeGeneric', () => {
  it('encodes a flat tabular array of employees', () => {
    const data = {
      employees: [
        { name: 'Alice', role: 'eng', level: 5 },
        { name: 'Bob', role: 'mgr', level: 7 },
        { name: 'Carol', role: 'eng', level: 4 },
      ],
    };

    const output = encodeGeneric(data);
    expect(output).toContain('## employees [3]{name,role,level}');
    expect(output).toContain('Alice|eng|5');
    expect(output).toContain('Bob|mgr|7');
    expect(output).toContain('Carol|eng|4');
    // Pure flat rows should not have @id prefixes.
    expect(output).not.toMatch(/@\d+ Alice/);
  });

  it('encodes a nested object', () => {
    const data = {
      server: {
        host: 'localhost',
        port: 8080,
        tls: {
          enabled: true,
          cert: '/path/to/cert',
        },
      },
    };

    const output = encodeGeneric(data);
    expect(output).toContain('## server');
    expect(output).toContain('host=localhost');
    expect(output).toContain('port=8080');
    expect(output).toContain('## tls');
    expect(output).toContain('enabled=true');
    expect(output).toContain('cert=/path/to/cert');
  });

  it('encodes mixed data with arrays and nested objects', () => {
    const data = {
      project: 'alpha',
      tasks: [
        { id: 1, title: 'Setup', assignee: { name: 'Alice' } },
        { id: 2, title: 'Build', assignee: { name: 'Bob' } },
      ],
    };

    const output = encodeGeneric(data);
    expect(output).toContain('GCF profile=generic');
    expect(output).toContain('project=alpha');
    // Tabular array with flattened nested field (v3.2).
    expect(output).toContain('## tasks [2]{id,title,"assignee>name"}');
    expect(output).toContain('1|Setup|Alice');
    expect(output).toContain('2|Build|Bob');
  });

  it('handles null and undefined values', () => {
    const data = {
      items: [
        { a: null, b: 'yes' },
        { a: undefined, b: 'no' },
      ],
    };

    const output = encodeGeneric(data);
    expect(output).toContain('-|yes');
    expect(output).toContain('-|no');
  });

  it('uses pipe separators and ## headers without repeated field names', () => {
    const data = {
      rows: [
        { x: 1, y: 2, z: 3 },
        { x: 4, y: 5, z: 6 },
      ],
    };

    const output = encodeGeneric(data);
    // Header declares fields once.
    expect(output).toContain('## rows [2]{x,y,z}');
    // Data rows use pipe separators.
    expect(output).toContain('1|2|3');
    expect(output).toContain('4|5|6');
    // Field names should not appear in data rows.
    const dataLines = output.split('\n').filter((l) => l.includes('|'));
    for (const line of dataLines) {
      expect(line).not.toContain('x=');
      expect(line).not.toContain('y=');
      expect(line).not.toContain('z=');
    }
  });

  it('encodes primitive values as root scalars', () => {
    expect(encodeGeneric(42)).toBe('GCF profile=generic\n=42\n');
    expect(encodeGeneric('hello')).toBe('GCF profile=generic\n=hello\n');
    expect(encodeGeneric(true)).toBe('GCF profile=generic\n=true\n');
    expect(encodeGeneric(null)).toBe('GCF profile=generic\n=-\n');
  });

  it('encodes primitive arrays inline', () => {
    const data = {
      mixed: [1, 'two', true],
    };

    const output = encodeGeneric(data);
    expect(output).toContain('mixed[3]: 1,two,true');
  });

  it('quotes strings containing pipe characters', () => {
    const data = {
      items: [
        { value: 'a|b' },
        { value: 'clean' },
      ],
    };

    const output = encodeGeneric(data);
    expect(output).toContain('"a|b"');
    expect(output).toContain('clean');
  });

  it('noFlatten option produces attachment syntax', () => {
    const data = {
      orders: [
        { id: 'ORD-1', customer: { name: 'Alice', email: 'alice@co.com' }, total: 99.99 },
        { id: 'ORD-2', customer: { name: 'Bob', email: 'bob@co.com' }, total: 49.99 },
      ],
    };

    const withFlatten = encodeGeneric(data);
    expect(withFlatten).toContain('customer>');

    const noFlatten = encodeGeneric(data, { noFlatten: true });
    expect(noFlatten).not.toContain('customer>');
    expect(noFlatten).toContain('.customer');

    // Both round-trip.
    expect(decodeGeneric(withFlatten)).toEqual(data);
    expect(decodeGeneric(noFlatten)).toEqual(data);
  });

  describe('> in field names', () => {
    function roundTrip(name: string, data: any) {
      it(`${name} (both flatten modes)`, () => {
        for (const noFlatten of [false, true]) {
          const encoded = encodeGeneric(data, { noFlatten });
          const decoded = decodeGeneric(encoded);
          expect(decoded).toEqual(data);
        }
      });
    }

    roundTrip('literal > key', [{ '>': 1 }, { '>': 2 }]);
    roundTrip('> at start', [{ '>foo': 'a', id: 1 }, { '>foo': 'b', id: 2 }]);
    roundTrip('> at end', [{ 'foo>': 'a', id: 1 }, { 'foo>': 'b', id: 2 }]);
    roundTrip('double >>', [{ 'a>>b': 'x' }, { 'a>>b': 'y' }]);
    roundTrip('multiple > in key', [{ 'a>b>c': 'x' }, { 'a>b>c': 'y' }]);
    roundTrip('> field with null', [{ 'a>b': null, id: 1 }, { 'a>b': 'hello', id: 2 }]);
    roundTrip('> field with object', [
      { 'a>b': { x: 1 }, id: 1 },
      { 'a>b': { x: 2 }, id: 2 },
    ]);
    roundTrip('> field with array', [
      { 'a>b': [1, 2], id: 1 },
      { 'a>b': [3], id: 2 },
    ]);
    roundTrip('all fields have >', [{ '>': 1, 'a>b': 2 }, { '>': 3, 'a>b': 4 }]);
    roundTrip('mix of > literal and flattened', [
      { id: 1, 'x>y': 'lit', nested: { a: 'v1', b: 'v2' } },
      { id: 2, 'x>y': 'lit2', nested: { a: 'v3', b: 'v4' } },
    ]);
    roundTrip('> field absent in some rows', [
      { id: 1, 'a>b': 'present' },
      { id: 2 },
    ]);
    roundTrip('key looks like flattened path', [
      { id: 1, 'customer>name': 'Alice' },
      { id: 2, 'customer>name': 'Bob' },
    ]);
  });
});
