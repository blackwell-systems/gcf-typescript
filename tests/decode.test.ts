import { describe, it, expect } from 'vitest';
import { decode } from '../src/decode.js';

describe('decode', () => {
  it('decodes a basic payload', () => {
    const input = [
      'GCF profile=graph tool=context_for_task budget=5000 tokens=1847 symbols=2',
      '## targets',
      '@0 fn pkg.AuthMiddleware 0.78 lsp_resolved',
      '## related',
      '@1 fn pkg.NewServer 0.54 lsp_resolved',
      '## edges',
      '@0<@1 calls',
    ].join('\n');

    const p = decode(input);
    expect(p.tool).toBe('context_for_task');
    expect(p.tokenBudget).toBe(5000);
    expect(p.tokensUsed).toBe(1847);
    expect(p.symbols).toHaveLength(2);
    expect(p.symbols[0].qualifiedName).toBe('pkg.AuthMiddleware');
    expect(p.symbols[0].kind).toBe('function');
    expect(p.symbols[0].score).toBeCloseTo(0.78);
    expect(p.symbols[0].provenance).toBe('lsp_resolved');
    expect(p.symbols[0].distance).toBe(0);
    expect(p.symbols[1].qualifiedName).toBe('pkg.NewServer');
    expect(p.symbols[1].distance).toBe(1);
    expect(p.edges).toHaveLength(1);
    expect(p.edges[0].source).toBe('pkg.NewServer');
    expect(p.edges[0].target).toBe('pkg.AuthMiddleware');
    expect(p.edges[0].edgeType).toBe('calls');
  });

  it('decodes with pack_root', () => {
    const input = [
      'GCF profile=graph tool=test budget=100 tokens=50 symbols=1 pack_root=abc123',
      '## targets',
      '@0 fn pkg.Func 0.90 rwr',
    ].join('\n');

    const p = decode(input);
    expect(p.packRoot).toBe('abc123');
  });

  it('expands kind abbreviations', () => {
    const input = [
      'GCF profile=graph tool=test budget=100 tokens=50 symbols=4',
      '## targets',
      '@0 iface pkg.Handler 0.90 rwr',
      '@1 route pkg.Get 0.80 rwr',
      '@2 ext pkg.Dep 0.70 rwr',
      '@3 pkg pkg.main 0.60 rwr',
    ].join('\n');

    const p = decode(input);
    expect(p.symbols[0].kind).toBe('interface');
    expect(p.symbols[1].kind).toBe('route_handler');
    expect(p.symbols[2].kind).toBe('external');
    expect(p.symbols[3].kind).toBe('package');
  });

  it('handles distance_N groups', () => {
    const input = [
      'GCF profile=graph tool=test budget=100 tokens=50 symbols=2',
      '## targets',
      '@0 fn pkg.A 0.90 rwr',
      '## distance_4',
      '@1 fn pkg.B 0.30 rwr',
    ].join('\n');

    const p = decode(input);
    expect(p.symbols[0].distance).toBe(0);
    expect(p.symbols[1].distance).toBe(4);
  });

  it('ignores comments', () => {
    const input = [
      'GCF profile=graph tool=test budget=100 tokens=50 symbols=1',
      '# This is a comment',
      '## targets',
      '@0 fn pkg.Func 0.90 rwr',
    ].join('\n');

    const p = decode(input);
    expect(p.symbols).toHaveLength(1);
  });

  it('handles CRLF line endings', () => {
    const input =
      'GCF profile=graph tool=test budget=100 tokens=50 symbols=1\r\n' +
      '## targets\r\n' +
      '@0 fn pkg.Func 0.90 rwr\r\n';

    const p = decode(input);
    expect(p.symbols).toHaveLength(1);
    expect(p.symbols[0].qualifiedName).toBe('pkg.Func');
  });

  it('decodes edge with status', () => {
    const input = [
      'GCF profile=graph tool=test budget=100 tokens=50 symbols=2',
      '## targets',
      '@0 fn pkg.A 0.90 rwr',
      '@1 fn pkg.B 0.80 rwr',
      '## edges',
      '@0<@1 calls added',
    ].join('\n');

    const p = decode(input);
    expect(p.edges[0].status).toBe('added');
  });

  it('throws on empty input', () => {
    expect(() => decode('')).toThrow('gcf: invalid header');
  });

  it('throws on invalid header', () => {
    expect(() => decode('INVALID header')).toThrow('gcf: invalid header');
  });

  it('throws on malformed symbol line', () => {
    const input = [
      'GCF profile=graph tool=test budget=100 tokens=50 symbols=1',
      '## targets',
      '@0 fn',
    ].join('\n');

    expect(() => decode(input)).toThrow('symbol line needs at least 5 fields');
  });

  it('throws on edge referencing unknown symbol', () => {
    const input = [
      'GCF profile=graph tool=test budget=100 tokens=50 symbols=1',
      '## targets',
      '@0 fn pkg.A 0.90 rwr',
      '## edges',
      '@0<@5 calls',
    ].join('\n');

    expect(() => decode(input)).toThrow('unknown symbol id');
  });
});
