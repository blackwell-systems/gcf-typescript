import { describe, it, expect } from 'vitest';
import { encode } from '../src/encode.js';
import { decode } from '../src/decode.js';
import type { Payload } from '../src/types.js';

describe('roundtrip', () => {
  it('encode then decode produces equivalent payload', () => {
    const original: Payload = {
      tool: 'context_for_task',
      tokenBudget: 5000,
      tokensUsed: 1847,
      packRoot: 'deadbeef1234',
      symbols: [
        { qualifiedName: 'pkg.AuthMiddleware', kind: 'function', score: 0.78, provenance: 'lsp_resolved', distance: 0 },
        { qualifiedName: 'pkg.Config', kind: 'type', score: 0.65, provenance: 'ast_inferred', distance: 0 },
        { qualifiedName: 'pkg.NewServer', kind: 'function', score: 0.54, provenance: 'lsp_resolved', distance: 1 },
        { qualifiedName: 'pkg.DB', kind: 'interface', score: 0.42, provenance: 'rwr', distance: 2 },
      ],
      edges: [
        { source: 'pkg.NewServer', target: 'pkg.AuthMiddleware', edgeType: 'calls' },
        { source: 'pkg.NewServer', target: 'pkg.Config', edgeType: 'imports' },
        { source: 'pkg.AuthMiddleware', target: 'pkg.DB', edgeType: 'implements' },
      ],
    };

    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded.tool).toBe(original.tool);
    expect(decoded.tokenBudget).toBe(original.tokenBudget);
    expect(decoded.tokensUsed).toBe(original.tokensUsed);
    expect(decoded.packRoot).toBe(original.packRoot);

    expect(decoded.symbols).toHaveLength(original.symbols.length);
    for (let i = 0; i < original.symbols.length; i++) {
      expect(decoded.symbols[i].qualifiedName).toBe(original.symbols[i].qualifiedName);
      expect(decoded.symbols[i].kind).toBe(original.symbols[i].kind);
      expect(decoded.symbols[i].score).toBeCloseTo(original.symbols[i].score, 1);
      expect(decoded.symbols[i].provenance).toBe(original.symbols[i].provenance);
      expect(decoded.symbols[i].distance).toBe(original.symbols[i].distance);
    }

    expect(decoded.edges).toHaveLength(original.edges.length);
    for (let i = 0; i < original.edges.length; i++) {
      expect(decoded.edges[i].source).toBe(original.edges[i].source);
      expect(decoded.edges[i].target).toBe(original.edges[i].target);
      expect(decoded.edges[i].edgeType).toBe(original.edges[i].edgeType);
    }
  });

  it('roundtrips empty payload', () => {
    const original: Payload = {
      tool: 'test',
      tokenBudget: 0,
      tokensUsed: 0,
      symbols: [],
      edges: [],
    };

    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded.tool).toBe('test');
    expect(decoded.symbols).toHaveLength(0);
    expect(decoded.edges).toHaveLength(0);
  });

  it('roundtrips multiple distance groups', () => {
    const original: Payload = {
      tool: 'test',
      tokenBudget: 1000,
      tokensUsed: 200,
      symbols: [
        { qualifiedName: 'a.Target', kind: 'function', score: 0.99, provenance: 'rwr', distance: 0 },
        { qualifiedName: 'a.Related', kind: 'method', score: 0.75, provenance: 'rwr', distance: 1 },
        { qualifiedName: 'a.Extended', kind: 'class', score: 0.50, provenance: 'rwr', distance: 2 },
        { qualifiedName: 'a.Far', kind: 'var', score: 0.25, provenance: 'rwr', distance: 5 },
      ],
      edges: [],
    };

    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded.symbols[0].distance).toBe(0);
    expect(decoded.symbols[1].distance).toBe(1);
    expect(decoded.symbols[2].distance).toBe(2);
    expect(decoded.symbols[3].distance).toBe(5);
  });

  it('roundtrips edge with status', () => {
    const original: Payload = {
      tool: 'test',
      tokenBudget: 100,
      tokensUsed: 50,
      symbols: [
        { qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
        { qualifiedName: 'a.B', kind: 'function', score: 0.8, provenance: 'rwr', distance: 0 },
      ],
      edges: [
        { source: 'a.B', target: 'a.A', edgeType: 'calls', status: 'added' },
      ],
    };

    const encoded = encode(original);
    const decoded = decode(encoded);

    expect(decoded.edges[0].status).toBe('added');
  });
});
