import { describe, it, expect } from 'vitest';
import { encodeDelta } from '../src/delta.js';
import type { DeltaPayload } from '../src/types.js';

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
