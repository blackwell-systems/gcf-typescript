import { describe, it, expect } from 'vitest';
import { StreamEncoder, decode } from '../src/index.js';

function collect(): { writer: { write: (s: string) => void }; output: () => string } {
  const chunks: string[] = [];
  return {
    writer: { write: (s: string) => chunks.push(s) },
    output: () => chunks.join(''),
  };
}

describe('StreamEncoder', () => {
  it('encodes basic graph with deferred counts and summary', () => {
    const { writer, output } = collect();
    const enc = new StreamEncoder(writer, 'context_for_task', { tokenBudget: 5000 });

    enc.writeSymbol({ qualifiedName: 'pkg.Auth', kind: 'function', score: 0.78, provenance: 'lsp_resolved', distance: 0 });
    enc.writeSymbol({ qualifiedName: 'pkg.Server', kind: 'function', score: 0.54, provenance: 'lsp_resolved', distance: 1 });
    enc.writeEdge({ source: 'pkg.Server', target: 'pkg.Auth', edgeType: 'calls' });
    enc.close();

    const out = output();
    expect(out).toContain('GCF tool=context_for_task budget=5000\n');
    expect(out).toContain('## targets\n');
    expect(out).toContain('@0 fn pkg.Auth 0.78 lsp_resolved\n');
    expect(out).toContain('## related\n');
    expect(out).toContain('@1 fn pkg.Server 0.54 lsp_resolved\n');
    expect(out).toContain('## edges [?]\n');
    expect(out).toContain('@0<@1 calls\n');
    expect(out).toContain('## _summary symbols=2 edges=1');

    // Header should not have symbols= or edges=
    const header = out.split('\n')[0];
    expect(header).not.toContain('symbols=');
    expect(header).not.toContain('edges=');
  });

  it('round-trips through standard decoder', () => {
    const { writer, output } = collect();
    const enc = new StreamEncoder(writer, 'blast_radius', { tokenBudget: 10000 });

    enc.writeSymbol({ qualifiedName: 'pkg.Auth', kind: 'function', score: 0.95, provenance: 'lsp', distance: 0 });
    enc.writeSymbol({ qualifiedName: 'pkg.Config', kind: 'type', score: 0.80, provenance: 'ast', distance: 0 });
    enc.writeSymbol({ qualifiedName: 'pkg.Server', kind: 'function', score: 0.60, provenance: 'lsp', distance: 1 });
    enc.writeEdge({ source: 'pkg.Server', target: 'pkg.Auth', edgeType: 'calls' });
    enc.writeEdge({ source: 'pkg.Auth', target: 'pkg.Config', edgeType: 'references' });
    enc.close();

    const p = decode(output());
    expect(p.tool).toBe('blast_radius');
    expect(p.symbols).toHaveLength(3);
    expect(p.edges).toHaveLength(2);
  });

  it('handles no edges', () => {
    const { writer, output } = collect();
    const enc = new StreamEncoder(writer, 'test');

    enc.writeSymbol({ qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'x', distance: 0 });
    enc.close();

    const out = output();
    expect(out).not.toContain('## edges');
    expect(out).toContain('edges=0');
  });

  it('handles multiple distance groups', () => {
    const { writer, output } = collect();
    const enc = new StreamEncoder(writer, 'test');

    enc.writeSymbol({ qualifiedName: 'a', kind: 'function', score: 1.0, provenance: 'x', distance: 0 });
    enc.writeSymbol({ qualifiedName: 'b', kind: 'function', score: 0.8, provenance: 'x', distance: 1 });
    enc.writeSymbol({ qualifiedName: 'c', kind: 'function', score: 0.6, provenance: 'x', distance: 2 });
    enc.writeSymbol({ qualifiedName: 'd', kind: 'function', score: 0.4, provenance: 'x', distance: 5 });
    enc.close();

    const out = output();
    expect(out).toContain('## targets\n');
    expect(out).toContain('## related\n');
    expect(out).toContain('## extended\n');
    expect(out).toContain('## distance_5\n');
    expect(out).toContain('sections=targets:1,related:1,extended:1,distance_5:1');
  });

  it('skips edges with unknown references', () => {
    const { writer, output } = collect();
    const enc = new StreamEncoder(writer, 'test');

    enc.writeSymbol({ qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'x', distance: 0 });
    enc.writeEdge({ source: 'unknown.B', target: 'a.A', edgeType: 'calls' });
    enc.close();

    const out = output();
    expect(out).not.toContain('calls');
    expect(out).toContain('edges=0');
  });

  it('writes incrementally (not buffered)', () => {
    const chunks: string[] = [];
    const writer = { write: (s: string) => chunks.push(s) };
    const enc = new StreamEncoder(writer, 'test');

    // Header written immediately on construction.
    expect(chunks.length).toBeGreaterThan(0);
    const afterHeader = chunks.length;

    enc.writeSymbol({ qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'x', distance: 0 });
    expect(chunks.length).toBeGreaterThan(afterHeader);

    const afterSymbol = chunks.length;
    enc.writeEdge({ source: 'a.A', target: 'a.A', edgeType: 'self' });
    expect(chunks.length).toBeGreaterThan(afterSymbol);

    enc.close();
  });

  it('supports bare refs (session mode)', () => {
    const { writer, output } = collect();
    const enc = new StreamEncoder(writer, 'test', { session: true });

    enc.writeBareRef('pkg.Auth', 0);
    enc.writeSymbol({ qualifiedName: 'pkg.New', kind: 'function', score: 0.85, provenance: 'lsp', distance: 0 });
    enc.close();

    const out = output();
    expect(out).toContain('session=true');
    expect(out).toContain('@0  # previously transmitted');
    expect(out).toContain('@1 fn pkg.New 0.85 lsp');
  });
});
