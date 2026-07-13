import { describe, it, expect } from 'vitest';
import { Session, encodeWithSession } from '../src/session.js';
import type { Payload } from '../src/types.js';

describe('Session', () => {
  it('tracks transmitted symbols', () => {
    const sess = new Session();
    expect(sess.size()).toBe(0);
    expect(sess.transmitted('pkg.Func')).toBe(false);

    sess.record([
      { qualifiedName: 'pkg.Func', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
    ]);

    expect(sess.size()).toBe(1);
    expect(sess.transmitted('pkg.Func')).toBe(true);
    expect(sess.getID('pkg.Func')).toBe(0);
  });

  it('assigns sequential IDs', () => {
    const sess = new Session();
    sess.record([
      { qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
      { qualifiedName: 'a.B', kind: 'function', score: 0.8, provenance: 'rwr', distance: 0 },
    ]);
    sess.record([
      { qualifiedName: 'a.C', kind: 'function', score: 0.7, provenance: 'rwr', distance: 0 },
    ]);

    expect(sess.getID('a.A')).toBe(0);
    expect(sess.getID('a.B')).toBe(1);
    expect(sess.getID('a.C')).toBe(2);
    expect(sess.getID('a.Unknown')).toBe(-1);
  });

  it('does not re-assign existing symbols', () => {
    const sess = new Session();
    sess.record([
      { qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
    ]);
    sess.record([
      { qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
      { qualifiedName: 'a.B', kind: 'function', score: 0.8, provenance: 'rwr', distance: 0 },
    ]);

    expect(sess.size()).toBe(2);
    expect(sess.getID('a.A')).toBe(0);
    expect(sess.getID('a.B')).toBe(1);
  });

  it('resets state', () => {
    const sess = new Session();
    sess.record([
      { qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
    ]);
    expect(sess.size()).toBe(1);

    sess.reset();
    expect(sess.size()).toBe(0);
    expect(sess.transmitted('a.A')).toBe(false);
  });
});

describe('encodeWithSession', () => {
  it('emits full declarations on first call', () => {
    const sess = new Session();
    const p: Payload = {
      tool: 'context_for_task',
      tokenBudget: 5000,
      tokensUsed: 500,
      symbols: [
        { qualifiedName: 'pkg.Func', kind: 'function', score: 0.90, provenance: 'lsp_resolved', distance: 0 },
      ],
      edges: [],
    };

    const output = encodeWithSession(p, sess);
    expect(output).toContain('session=true');
    expect(output).toContain('@0 fn pkg.Func 0.90 lsp_resolved');
    expect(output).not.toContain('previously transmitted');
  });

  it('emits bare refs for previously transmitted symbols', () => {
    const sess = new Session();

    const p1: Payload = {
      tool: 'context_for_task',
      tokenBudget: 5000,
      tokensUsed: 500,
      symbols: [
        { qualifiedName: 'pkg.Func', kind: 'function', score: 0.90, provenance: 'lsp_resolved', distance: 0 },
        { qualifiedName: 'pkg.Helper', kind: 'function', score: 0.70, provenance: 'rwr', distance: 1 },
      ],
      edges: [],
    };

    // First call: full declarations.
    const out1 = encodeWithSession(p1, sess);
    expect(out1).toContain('@0 fn pkg.Func 0.90 lsp_resolved');
    expect(out1).toContain('@1 fn pkg.Helper 0.70 rwr');

    // Second call: reuse one symbol, add one new.
    const p2: Payload = {
      tool: 'context_for_task',
      tokenBudget: 5000,
      tokensUsed: 300,
      symbols: [
        { qualifiedName: 'pkg.Func', kind: 'function', score: 0.90, provenance: 'lsp_resolved', distance: 0 },
        { qualifiedName: 'pkg.NewFunc', kind: 'function', score: 0.60, provenance: 'rwr', distance: 1 },
      ],
      edges: [
        { source: 'pkg.Func', target: 'pkg.NewFunc', edgeType: 'calls' },
      ],
    };

    const out2 = encodeWithSession(p2, sess);
    // pkg.Func was already sent, should be bare ref keeping its session ID @0.
    expect(out2).toContain('@0  # previously transmitted');
    // pkg.NewFunc is new; session IDs are stable/global, so it gets the next
    // session ID @2 (pkg.Func=@0, pkg.Helper=@1 were assigned on the first call).
    expect(out2).toContain('@2 fn pkg.NewFunc 0.60 rwr');
    // Edges reference the stable session IDs.
    expect(out2).toContain('@2<@0 calls');
  });

  it('records new symbols after encoding', () => {
    const sess = new Session();
    const p: Payload = {
      tool: 'test',
      tokenBudget: 100,
      tokensUsed: 50,
      symbols: [
        { qualifiedName: 'a.A', kind: 'function', score: 0.9, provenance: 'rwr', distance: 0 },
        { qualifiedName: 'a.B', kind: 'function', score: 0.8, provenance: 'rwr', distance: 0 },
      ],
      edges: [],
    };

    encodeWithSession(p, sess);
    expect(sess.size()).toBe(2);
    expect(sess.transmitted('a.A')).toBe(true);
    expect(sess.transmitted('a.B')).toBe(true);
  });
});
