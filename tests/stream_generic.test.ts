import { describe, it, expect } from 'vitest';
import { GenericStreamEncoder } from '../src/index.js';

function collect(): { writer: { write: (s: string) => void }; output: () => string } {
  const chunks: string[] = [];
  return {
    writer: { write: (s: string) => chunks.push(s) },
    output: () => chunks.join(''),
  };
}

describe('GenericStreamEncoder', () => {
  it('encodes tabular data with header and summary', () => {
    const { writer, output } = collect();
    const enc = new GenericStreamEncoder(writer);

    enc.beginArray('employees', ['id', 'name', 'department', 'salary']);
    enc.writeRow([1, 'Alice', 'Engineering', 95000]);
    enc.writeRow([2, 'Bob', 'Sales', 72000]);
    enc.writeRow([3, 'Carol', 'Marketing', 85000]);
    enc.endArray();
    enc.close();

    const out = output();
    expect(out).toContain('## employees [?]{id,name,department,salary}');
    expect(out).toContain('1|Alice|Engineering|95000');
    expect(out).toContain('## _summary rows=3 sections=employees:3');
  });

  it('encodes KV and inline arrays', () => {
    const { writer, output } = collect();
    const enc = new GenericStreamEncoder(writer);

    enc.writeKV('name', 'my-service');
    enc.writeKV('version', '2.1.0');
    enc.writeInlineArray('tags', ['production', 'us-east-1', 'critical']);
    enc.close();

    const out = output();
    expect(out).toContain('name=my-service');
    expect(out).toContain('tags[3]: production,us-east-1,critical');
  });

  it('writes rows incrementally', () => {
    const chunks: string[] = [];
    const writer = { write: (s: string) => chunks.push(s) };
    const enc = new GenericStreamEncoder(writer);

    enc.beginArray('data', ['id', 'val']);
    expect(chunks.length).toBeGreaterThan(0);

    const headerChunks = chunks.length;
    enc.writeRow([1, 'a']);
    expect(chunks.length).toBeGreaterThan(headerChunks);

    enc.endArray();
    enc.close();
  });

  it('handles multiple arrays with correct summary', () => {
    const { writer, output } = collect();
    const enc = new GenericStreamEncoder(writer);

    enc.beginArray('users', ['id', 'name']);
    enc.writeRow([1, 'Alice']);
    enc.writeRow([2, 'Bob']);
    enc.endArray();

    enc.beginArray('roles', ['name', 'level']);
    enc.writeRow(['admin', 10]);
    enc.endArray();

    enc.close();

    const out = output();
    expect(out).toContain('sections=users:2,roles:1');
  });

  it('handles null and boolean values', () => {
    const { writer, output } = collect();
    const enc = new GenericStreamEncoder(writer);

    enc.beginArray('data', ['a', 'b', 'c']);
    enc.writeRow([null, true, false]);
    enc.endArray();
    enc.close();

    const out = output();
    expect(out).toContain('-|true|false');
  });

  it('handles empty string and special characters', () => {
    const { writer, output } = collect();
    const enc = new GenericStreamEncoder(writer);

    enc.beginArray('data', ['a', 'b']);
    enc.writeRow(['', 'has|pipe']);
    enc.endArray();
    enc.close();

    const out = output();
    expect(out).toContain('""|"has|pipe"');
  });

  it('auto-closes array on beginArray', () => {
    const { writer, output } = collect();
    const enc = new GenericStreamEncoder(writer);

    enc.beginArray('first', ['a']);
    enc.writeRow([1]);
    // starting new array auto-closes previous
    enc.beginArray('second', ['b']);
    enc.writeRow([2]);
    enc.endArray();
    enc.close();

    const out = output();
    expect(out).toContain('sections=first:1,second:1');
  });

  it('writeSection auto-closes current array', () => {
    const { writer, output } = collect();
    const enc = new GenericStreamEncoder(writer);

    enc.beginArray('items', ['id']);
    enc.writeRow([1]);
    enc.writeSection('metadata');
    enc.writeKV('count', 1);
    enc.close();

    const out = output();
    expect(out).toContain('## metadata');
    expect(out).toContain('## _summary rows=1 sections=items:1');
  });
});
