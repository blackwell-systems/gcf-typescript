import { describe, it, expect } from 'vitest';
import {
  GenericDeltaSession,
  fixedN,
  sizeGuard,
  genericPackRoot,
  decodeGenericFull,
  decodeGenericDelta,
  verifyGenericDelta,
  type GenericSet,
  type ReanchorPolicy,
} from '../src/index.js';

// --- scenario builders (mirror gcf-go generic_delta_session_test.go) ---

function sessBase(): GenericSet {
  return {
    name: 'orders', key: 'id', fields: ['id', 'total', 'status', 'customer'],
    rows: [
      { id: 1001, total: 59.98, status: 'shipped', customer: 'Alice' },
      { id: 1002, total: 29.99, status: 'pending', customer: 'Bob' },
      { id: 1003, total: 129.5, status: 'shipped', customer: 'Carol' },
    ],
  };
}

function mkOrders(...rows: Array<Record<string, unknown>>): GenericSet {
  return { name: 'orders', key: 'id', fields: ['id', 'total', 'status', 'customer'], rows };
}

function sessUpdates(): GenericSet[] {
  return [
    mkOrders(
      { id: 1001, total: 59.98, status: 'shipped', customer: 'Alice' },
      { id: 1002, total: 29.99, status: 'shipped', customer: 'Bob' }, // changed
      { id: 1003, total: 129.5, status: 'shipped', customer: 'Carol' },
    ),
    mkOrders( // add 1004
      { id: 1001, total: 59.98, status: 'shipped', customer: 'Alice' },
      { id: 1002, total: 29.99, status: 'shipped', customer: 'Bob' },
      { id: 1003, total: 129.5, status: 'shipped', customer: 'Carol' },
      { id: 1004, total: 75.0, status: 'pending', customer: 'Dave' },
    ),
    mkOrders( // remove 1001
      { id: 1002, total: 29.99, status: 'shipped', customer: 'Bob' },
      { id: 1003, total: 129.5, status: 'shipped', customer: 'Carol' },
      { id: 1004, total: 75.0, status: 'pending', customer: 'Dave' },
    ),
    mkOrders( // change 1003
      { id: 1002, total: 29.99, status: 'shipped', customer: 'Bob' },
      { id: 1003, total: 140.0, status: 'delivered', customer: 'Carol' },
      { id: 1004, total: 75.0, status: 'pending', customer: 'Dave' },
    ),
    mkOrders( // add 1005
      { id: 1002, total: 29.99, status: 'shipped', customer: 'Bob' },
      { id: 1003, total: 140.0, status: 'delivered', customer: 'Carol' },
      { id: 1004, total: 75.0, status: 'pending', customer: 'Dave' },
      { id: 1005, total: 12.0, status: 'pending', customer: 'Eve' },
    ),
  ];
}

function sizeGuardBase(): GenericSet {
  const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi',
    'Ivan', 'Judy', 'Mallory', 'Niaj', 'Olivia', 'Peggy', 'Rupert', 'Sybil',
    'Trent', 'Uma', 'Victor', 'Walter'];
  const rows = names.map((n, i) => ({
    id: 2000 + i, total: 10 + i, status: 'pending', customer: n,
  }));
  return { name: 'rows', key: 'id', fields: ['id', 'total', 'status', 'customer'], rows };
}

function sizeGuardUpdates(): GenericSet[] {
  const base = sizeGuardBase();
  const clone = (): GenericSet => ({
    name: base.name, key: base.key, fields: base.fields,
    rows: base.rows.map((r) => ({ ...r })),
  });
  const ups: GenericSet[] = [];
  for (let turn = 0; turn < 6; turn++) {
    const g = clone();
    g.rows[turn].status = 'shipped'; // change one distinct row's status each turn
    ups.push(g);
  }
  return ups;
}

// --- unit tests ---

describe('GenericDeltaSession', () => {
  it('FixedN(3) re-anchors on turn 3: delta,delta,FULL,delta,delta', () => {
    const s = new GenericDeltaSession(sessBase(), 'orders_query', fixedN(3));
    const wantFull = [false, false, true, false, false];
    sessUpdates().forEach((up, i) => {
      const { isFull } = s.next(up);
      expect(isFull, `turn ${i + 1}`).toBe(wantFull[i]);
    });
  });

  it('SizeGuard triggers at least one re-anchor', () => {
    const s = new GenericDeltaSession(sizeGuardBase(), '', sizeGuard());
    let anchors = 0;
    sizeGuardUpdates().forEach((up) => {
      if (s.next(up).isFull) anchors++;
    });
    expect(anchors).toBeGreaterThanOrEqual(1);
  });

  it('a schema change forces a full re-anchor', () => {
    const s = new GenericDeltaSession(sessBase(), 'orders_query', fixedN(15));
    const changed = sessBase();
    changed.fields = ['id', 'total', 'status']; // drop a column
    changed.rows = [{ id: 1001, total: 59.98, status: 'shipped' }];
    expect(s.next(changed).isFull).toBe(true);
  });

  it('FixedN(15) over 30 same-schema turns yields exactly 2 fulls (turns 15, 30)', () => {
    const s = new GenericDeltaSession(sessBase(), 'orders_query', fixedN(15));
    s.currentFull(); // bootstrap full (turn 0), not counted

    let fulls = 0;
    let deltas = 0;
    const fullTurns: number[] = [];
    let prev = sessBase();
    for (let turn = 1; turn <= 30; turn++) {
      const next: GenericSet = { name: prev.name, key: prev.key, fields: prev.fields, rows: [] };
      prev.rows.forEach((r, j) => {
        const nr = { ...r };
        if (j === turn % prev.rows.length) nr.total = turn + 0.5;
        next.rows.push(nr);
      });
      const { isFull } = s.next(next);
      if (isFull) { fulls++; fullTurns.push(turn); } else { deltas++; }
      prev = next;
    }
    expect(fulls).toBe(2);
    expect(deltas).toBe(28);
    expect(fullTurns).toEqual([15, 30]);
  });

  // The load-bearing test: a consumer applying each emission stays byte-for-byte
  // in sync with the producer's state at every turn, under both policies.
  const syncCases: Array<{ name: string; base: GenericSet; ups: GenericSet[]; tool: string; policy: ReanchorPolicy }> = [
    { name: 'fixedN3', base: sessBase(), ups: sessUpdates(), tool: 'orders_query', policy: fixedN(3) },
    { name: 'sizeGuard', base: sizeGuardBase(), ups: sizeGuardUpdates(), tool: '', policy: sizeGuard() },
  ];

  for (const tc of syncCases) {
    it(`consumer stays in sync (${tc.name})`, () => {
      const s = new GenericDeltaSession(tc.base, tc.tool, tc.policy);
      let held = decodeGenericFull(s.currentFull()).set;
      tc.ups.forEach((up, i) => {
        const { wire, isFull } = s.next(up);
        if (isFull) {
          held = decodeGenericFull(wire).set;
        } else {
          const d = decodeGenericDelta(wire);
          held = verifyGenericDelta(held, d, d.newRoot);
        }
        expect(genericPackRoot(held), `turn ${i + 1} (isFull=${isFull})`).toBe(genericPackRoot(up));
      });
    });
  }
});
