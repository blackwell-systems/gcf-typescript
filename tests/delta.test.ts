import { describe, it, expect } from 'vitest';
import { encodeDelta, verifyDelta } from '../src/delta.js';
import { packRoot } from '../src/packroot.js';
import type { DeltaPayload, Symbol as GcfSymbol, Edge } from '../src/types.js';

describe('encodeDelta', () => {
  it('encodes a delta payload with all sections', () => {
    const d: DeltaPayload = {
      tool: 'context_for_task',
      baseRoot: 'aaa111',
      newRoot: 'bbb222',
      removed: [
        { qualifiedName: 'pkg.OldHandler', kind: 'function', score: 0, provenance: '', distance: 0 },
      ],
      added: [
        { qualifiedName: 'pkg.NewHandler', kind: 'function', score: 0.85, provenance: 'rwr', distance: 0 },
      ],
      removedEdges: [
        { source: 'pkg.Router', target: 'pkg.OldHandler', edgeType: 'calls' },
      ],
      addedEdges: [
        { source: 'pkg.Router', target: 'pkg.NewHandler', edgeType: 'calls' },
      ],
      deltaTokens: 30,
      fullTokens: 200,
    };

    const output = encodeDelta(d);

    expect(output).toContain('GCF profile=graph tool=context_for_task delta=true base_root=aaa111 new_root=bbb222 tokens=30 savings=85%');
    expect(output).toContain('## removed');
    expect(output).toContain('fn pkg.OldHandler');
    expect(output).toContain('## added');
    expect(output).toContain('@0 fn pkg.NewHandler 0.85 rwr');
    expect(output).toContain('## edges_removed');
    expect(output).toContain('pkg.Router -> pkg.OldHandler calls');
    expect(output).toContain('## edges_added');
    expect(output).toContain('pkg.Router -> pkg.NewHandler calls');
  });

  it('computes savings percentage correctly', () => {
    const d: DeltaPayload = {
      tool: 'test',
      baseRoot: 'aaa',
      newRoot: 'bbb',
      removed: [],
      added: [
        { qualifiedName: 'pkg.Func', kind: 'function', score: 0.50, provenance: 'rwr', distance: 0 },
      ],
      removedEdges: [],
      addedEdges: [],
      deltaTokens: 20,
      fullTokens: 100,
    };

    const output = encodeDelta(d);
    expect(output).toContain('savings=80%');
  });

  it('handles zero fullTokens without error', () => {
    const d: DeltaPayload = {
      tool: 'test',
      baseRoot: 'aaa',
      newRoot: 'bbb',
      removed: [],
      added: [],
      removedEdges: [],
      addedEdges: [],
      deltaTokens: 0,
      fullTokens: 0,
    };

    const output = encodeDelta(d);
    expect(output).toContain('savings=0%');
  });

  it('omits empty sections', () => {
    const d: DeltaPayload = {
      tool: 'test',
      baseRoot: 'aaa',
      newRoot: 'bbb',
      removed: [],
      added: [
        { qualifiedName: 'pkg.Func', kind: 'method', score: 0.70, provenance: 'ast_inferred', distance: 0 },
      ],
      removedEdges: [],
      addedEdges: [],
      deltaTokens: 10,
      fullTokens: 50,
    };

    const output = encodeDelta(d);
    expect(output).not.toContain('## removed');
    expect(output).toContain('## added');
    expect(output).toContain('method pkg.Func');
    expect(output).not.toContain('## edges_removed');
    expect(output).not.toContain('## edges_added');
  });

  it('abbreviates kind names in removed section', () => {
    const d: DeltaPayload = {
      tool: 'test',
      baseRoot: 'aaa',
      newRoot: 'bbb',
      removed: [
        { qualifiedName: 'pkg.Thing', kind: 'interface', score: 0, provenance: '', distance: 0 },
        { qualifiedName: 'pkg.Svc', kind: 'service', score: 0, provenance: '', distance: 0 },
      ],
      added: [],
      removedEdges: [],
      addedEdges: [],
      deltaTokens: 5,
      fullTokens: 100,
    };

    const output = encodeDelta(d);
    expect(output).toContain('iface pkg.Thing');
    expect(output).toContain('svc pkg.Svc');
  });
});

describe('packRoot', () => {
  const symbols: GcfSymbol[] = [
    { qualifiedName: 'pkg.Handler', kind: 'function', score: 0.85, provenance: 'lsp_resolved', distance: 0 },
    { qualifiedName: 'pkg.Middleware', kind: 'function', score: 0.7, provenance: 'ast_inferred', distance: 1 },
  ];
  const edges: Edge[] = [
    { source: 'pkg.Handler', target: 'pkg.Middleware', edgeType: 'calls' },
  ];

  it('produces consistent hash for same input', () => {
    const h1 = packRoot(symbols, edges);
    const h2 = packRoot(symbols, edges);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('produces different hash for different input', () => {
    const h1 = packRoot(symbols, edges);

    const differentSymbols: GcfSymbol[] = [
      { qualifiedName: 'pkg.Other', kind: 'type', score: 0.5, provenance: 'lsp_resolved', distance: 0 },
    ];
    const h2 = packRoot(differentSymbols, []);
    expect(h1).not.toBe(h2);
  });

  it('is order-independent (sorted canonically)', () => {
    const reversed = [...symbols].reverse();
    const h1 = packRoot(symbols, edges);
    const h2 = packRoot(reversed, edges);
    expect(h1).toBe(h2);
  });
});

describe('verifyDelta', () => {
  const baseSymbols: GcfSymbol[] = [
    { qualifiedName: 'pkg.Handler', kind: 'function', score: 0.85, provenance: 'lsp_resolved', distance: 0 },
    { qualifiedName: 'pkg.OldHelper', kind: 'function', score: 0.6, provenance: 'ast_inferred', distance: 1 },
  ];
  const baseEdges: Edge[] = [
    { source: 'pkg.Handler', target: 'pkg.OldHelper', edgeType: 'calls' },
  ];

  const removedSymbols: GcfSymbol[] = [
    { qualifiedName: 'pkg.OldHelper', kind: 'function', score: 0.6, provenance: 'ast_inferred', distance: 1 },
  ];
  const addedSymbols: GcfSymbol[] = [
    { qualifiedName: 'pkg.NewHelper', kind: 'function', score: 0.75, provenance: 'lsp_resolved', distance: 1 },
  ];
  const removedEdges: Edge[] = [
    { source: 'pkg.Handler', target: 'pkg.OldHelper', edgeType: 'calls' },
  ];
  const addedEdges: Edge[] = [
    { source: 'pkg.Handler', target: 'pkg.NewHelper', edgeType: 'calls' },
  ];

  it('succeeds on valid delta', () => {
    // Compute the expected new root from the expected final state.
    const expectedSymbols: GcfSymbol[] = [
      { qualifiedName: 'pkg.Handler', kind: 'function', score: 0.85, provenance: 'lsp_resolved', distance: 0 },
      { qualifiedName: 'pkg.NewHelper', kind: 'function', score: 0.75, provenance: 'lsp_resolved', distance: 1 },
    ];
    const expectedEdges: Edge[] = [
      { source: 'pkg.Handler', target: 'pkg.NewHelper', edgeType: 'calls' },
    ];
    const expectedNewRoot = packRoot(expectedSymbols, expectedEdges);

    const result = verifyDelta(
      baseSymbols,
      baseEdges,
      removedSymbols,
      addedSymbols,
      removedEdges,
      addedEdges,
      expectedNewRoot,
    );

    expect(result.symbols).toHaveLength(2);
    expect(result.edges).toHaveLength(1);
    expect(result.symbols.find((s) => s.qualifiedName === 'pkg.NewHelper')).toBeDefined();
    expect(result.symbols.find((s) => s.qualifiedName === 'pkg.OldHelper')).toBeUndefined();
  });

  it('fails on root mismatch', () => {
    expect(() =>
      verifyDelta(
        baseSymbols,
        baseEdges,
        removedSymbols,
        addedSymbols,
        removedEdges,
        addedEdges,
        'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      ),
    ).toThrow('pack root mismatch');
  });
});
