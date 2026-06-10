import { describe, it, expect } from 'vitest';
import { encode } from '../src/encode.js';
import type { Payload } from '../src/types.js';

describe('encode', () => {
  it('encodes a basic payload with targets and related', () => {
    const p: Payload = {
      tool: 'context_for_task',
      tokenBudget: 5000,
      tokensUsed: 1847,
      symbols: [
        {
          qualifiedName: 'pkg.AuthMiddleware',
          kind: 'function',
          score: 0.78,
          provenance: 'lsp_resolved',
          distance: 0,
        },
        {
          qualifiedName: 'pkg.NewServer',
          kind: 'function',
          score: 0.54,
          provenance: 'lsp_resolved',
          distance: 1,
        },
      ],
      edges: [
        { source: 'pkg.NewServer', target: 'pkg.AuthMiddleware', edgeType: 'calls' },
      ],
    };

    const output = encode(p);
    const expected = [
      'GCF profile=graph tool=context_for_task budget=5000 tokens=1847 symbols=2 edges=1',
      '## targets',
      '@0 fn pkg.AuthMiddleware 0.78 lsp_resolved',
      '## related',
      '@1 fn pkg.NewServer 0.54 lsp_resolved',
      '## edges [1]',
      '@0<@1 calls',
      '',
    ].join('\n');

    expect(output).toBe(expected);
  });

  it('encodes with pack_root', () => {
    const p: Payload = {
      tool: 'context_for_files',
      tokenBudget: 3000,
      tokensUsed: 500,
      packRoot: 'abc123def456',
      symbols: [
        {
          qualifiedName: 'pkg.Handler',
          kind: 'type',
          score: 0.90,
          provenance: 'ast_inferred',
          distance: 0,
        },
      ],
      edges: [],
    };

    const output = encode(p);
    expect(output).toContain('pack_root=abc123def456');
    expect(output).toContain('@0 type pkg.Handler 0.90 ast_inferred');
  });

  it('abbreviates kind names', () => {
    const p: Payload = {
      tool: 'test',
      tokenBudget: 100,
      tokensUsed: 50,
      symbols: [
        { qualifiedName: 'a.Foo', kind: 'interface', score: 0.5, provenance: 'rwr', distance: 0 },
        { qualifiedName: 'a.Bar', kind: 'route_handler', score: 0.4, provenance: 'rwr', distance: 0 },
        { qualifiedName: 'a.Baz', kind: 'external', score: 0.3, provenance: 'rwr', distance: 0 },
        { qualifiedName: 'a.Pkg', kind: 'package', score: 0.2, provenance: 'rwr', distance: 0 },
      ],
      edges: [],
    };

    const output = encode(p);
    expect(output).toContain('iface a.Foo');
    expect(output).toContain('route a.Bar');
    expect(output).toContain('ext a.Baz');
    expect(output).toContain('pkg a.Pkg');
  });

  it('passes through unknown kinds verbatim', () => {
    const p: Payload = {
      tool: 'test',
      tokenBudget: 100,
      tokensUsed: 50,
      symbols: [
        { qualifiedName: 'a.Thing', kind: 'custom_kind', score: 0.5, provenance: 'rwr', distance: 0 },
      ],
      edges: [],
    };

    const output = encode(p);
    expect(output).toContain('custom_kind a.Thing');
  });

  it('encodes extended and distance_N groups', () => {
    const p: Payload = {
      tool: 'test',
      tokenBudget: 100,
      tokensUsed: 50,
      symbols: [
        { qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
        { qualifiedName: 'a.B', kind: 'function', score: 0.7, provenance: 'rwr', distance: 2 },
        { qualifiedName: 'a.C', kind: 'function', score: 0.5, provenance: 'rwr', distance: 5 },
      ],
      edges: [],
    };

    const output = encode(p);
    expect(output).toContain('## targets');
    expect(output).toContain('## extended');
    expect(output).toContain('## distance_5');
  });

  it('emits edges header but skips lines with unknown source/target', () => {
    const p: Payload = {
      tool: 'test',
      tokenBudget: 100,
      tokensUsed: 50,
      symbols: [
        { qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
      ],
      edges: [
        { source: 'a.Unknown', target: 'a.A', edgeType: 'calls' },
      ],
    };

    const output = encode(p);
    // Section header emitted with count 0 (matches Go), no edge lines beneath it
    expect(output).toContain('## edges [0]');
    // edges=0 omitted when zero per v2.0
    const afterEdges = output.split('## edges [0]\n')[1];
    expect(afterEdges!.trim()).toBe('');
  });

  it('includes edge status when not empty or unchanged', () => {
    const p: Payload = {
      tool: 'test',
      tokenBudget: 100,
      tokensUsed: 50,
      symbols: [
        { qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
        { qualifiedName: 'a.B', kind: 'function', score: 0.7, provenance: 'rwr', distance: 0 },
      ],
      edges: [
        { source: 'a.B', target: 'a.A', edgeType: 'calls', status: 'added' },
      ],
    };

    const output = encode(p);
    expect(output).toContain('@0<@1 calls added');
  });
});
