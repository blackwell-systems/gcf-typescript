import { describe, it, expect } from 'vitest';
import { encodeGeneric } from '../src/generic.js';

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
    expect(output).toContain('project=alpha');
    // Tabular array with nested field: uses @N prefix.
    expect(output).toContain('## tasks [2]{id,title}');
    expect(output).toContain('@0 1|Setup');
    expect(output).toContain('@1 2|Build');
    // Nested assignee objects.
    expect(output).toContain('## assignee');
    expect(output).toContain('name=Alice');
    expect(output).toContain('name=Bob');
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

  it('encodes primitive values directly', () => {
    expect(encodeGeneric(42)).toBe('42');
    expect(encodeGeneric('hello')).toBe('hello');
    expect(encodeGeneric(true)).toBe('true');
    expect(encodeGeneric(null)).toBe('null');
  });

  it('encodes non-uniform arrays with @N indices', () => {
    const data = {
      mixed: [1, 'two', true],
    };

    const output = encodeGeneric(data);
    expect(output).toContain('## mixed [3]');
    expect(output).toContain('@0 1');
    expect(output).toContain('@1 two');
    expect(output).toContain('@2 true');
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
});
