import { describe, it, expect } from 'vitest';
import {
  canonicalCell,
  genericPackRoot,
  diffGenericSets,
  encodeGenericFull,
  encodeGenericDelta,
  decodeGenericFull,
  decodeGenericDelta,
  verifyGenericDelta,
  type GenericSet,
  type GenericDeltaPayload,
} from '../src/generic_delta.js';

function ordersBase(): GenericSet {
  return {
    key: 'id', name: 'orders', fields: ['id', 'total', 'status', 'customer'],
    rows: [
      { id: 1001, total: 59.98, status: 'shipped', customer: 'Alice' },
      { id: 1002, total: 29.99, status: 'pending', customer: 'Bob' },
      { id: 1003, total: 129.50, status: 'shipped', customer: 'Carol' },
    ],
  };
}

function ordersNext(): GenericSet {
  return {
    key: 'id', name: 'orders', fields: ['id', 'total', 'status', 'customer'],
    rows: [
      { id: 1002, total: 29.99, status: 'shipped', customer: 'Bob' },
      { id: 1003, total: 129.50, status: 'shipped', customer: 'Carol' },
      { id: 1004, total: 75.00, status: 'pending', customer: 'Dave' },
    ],
  };
}

describe('generic-profile delta (Section 10a)', () => {
  it('round-trips diff -> apply by root', () => {
    const base = ordersBase(), next = ordersNext();
    const d = diffGenericSets(base, next);
    expect([d.added.length, d.changed.length, d.removed.length]).toEqual([1, 1, 1]);
    expect(d.newRoot).toBe(genericPackRoot(next));
    const result = verifyGenericDelta(base, d, genericPackRoot(next));
    expect(genericPackRoot(result)).toBe(genericPackRoot(next));
  });

  it('pack root is row-order invariant', () => {
    const a = ordersBase();
    const b = ordersBase();
    b.rows = [b.rows[2], b.rows[0], b.rows[1]];
    expect(genericPackRoot(a)).toBe(genericPackRoot(b));
  });

  it('canonical cell has no type collisions', () => {
    expect(canonicalCell(null)).toBe('-');
    expect(canonicalCell(true)).toBe('true');
    expect(canonicalCell('true')).toBe('"true"');
    expect(canonicalCell('-')).toBe('"-"');
    expect(canonicalCell(59.98)).toBe('59.98');
    expect(canonicalCell('59.98')).toBe('"59.98"');
    expect(canonicalCell('a\tb')).toBe('"a\\tb"');
  });

  it('enforces every invariant', () => {
    const base = ordersBase();
    const baseRoot = genericPackRoot(base);

    const dup = ordersBase();
    dup.rows.push({ id: 1001, total: 1.0, status: 'x', customer: 'y' });
    expect(() => diffGenericSets(dup, ordersNext())).toThrow('duplicate identity');

    const sc = ordersNext();
    sc.fields = ['id', 'total', 'status'];
    expect(() => diffGenericSets(base, sc)).toThrow('schema change');

    const addExisting: GenericDeltaPayload = {
      key: 'id', fields: base.fields, baseRoot, newRoot: '',
      added: [{ id: 1001, total: 1.0, status: 's', customer: 'c' }], changed: [], removed: [],
    };
    expect(() => verifyGenericDelta(base, addExisting, 'sha256:x')).toThrow('already exists');

    const changeMissing: GenericDeltaPayload = {
      key: 'id', fields: base.fields, baseRoot, newRoot: '',
      added: [], changed: [{ id: 9999, total: 1.0, status: 's', customer: 'c' }], removed: [],
    };
    expect(() => verifyGenericDelta(base, changeMissing, 'sha256:x')).toThrow('not in base');

    const removeMissing: GenericDeltaPayload = {
      key: 'id', fields: base.fields, baseRoot, newRoot: '', added: [], changed: [], removed: [9999],
    };
    expect(() => verifyGenericDelta(base, removeMissing, 'sha256:x')).toThrow('not in base');

    const wrongBase: GenericDeltaPayload = {
      key: 'id', fields: base.fields, baseRoot: 'sha256:wrong', newRoot: '', added: [], changed: [], removed: [],
    };
    expect(() => verifyGenericDelta(base, wrongBase, baseRoot)).toThrow('base_mismatch');

    const d = diffGenericSets(base, ordersNext());
    expect(() => verifyGenericDelta(base, d, 'sha256:deadbeef')).toThrow('root_mismatch');
  });

  it('full wire round-trips', () => {
    const base = ordersBase();
    const { set, packRoot } = decodeGenericFull(encodeGenericFull(base, 'orders_query'));
    expect(genericPackRoot(set)).toBe(genericPackRoot(base));
    expect(packRoot).toBe(genericPackRoot(base));
  });

  it('runs the full server -> wire -> consumer loop', () => {
    const base = ordersBase(), next = ordersNext();
    const { set: held } = decodeGenericFull(encodeGenericFull(base, 'orders_query'));
    const d = diffGenericSets(base, next);
    const parsed = decodeGenericDelta(encodeGenericDelta(d));
    const result = verifyGenericDelta(held, parsed, genericPackRoot(next));
    expect(genericPackRoot(result)).toBe(genericPackRoot(next));
  });

  it('handles nulls and string keys', () => {
    const nulls: GenericSet = {
      key: 'id', name: 'items', fields: ['id', 'total', 'status', 'customer'],
      rows: [
        { id: 2001, total: 10.0, status: null, customer: 'Amy' },
        { id: 2002, total: null, status: 'open', customer: null },
      ],
    };
    const { set: got } = decodeGenericFull(encodeGenericFull(nulls, ''));
    expect(genericPackRoot(got)).toBe(genericPackRoot(nulls));

    const sku: GenericSet = {
      key: 'sku', name: 'parts', fields: ['sku', 'name', 'qty'],
      rows: [
        { sku: '1001', name: 'Widget', qty: 5 }, // "1001" spells a number -> quoted
        { sku: 'A-200', name: 'Gadget', qty: 3 },
      ],
    };
    const { set: got2 } = decodeGenericFull(encodeGenericFull(sku, ''));
    expect(genericPackRoot(got2)).toBe(genericPackRoot(sku));
  });

  it('fails closed on malformed delta wire', () => {
    const cases = [
      '',
      'GCF profile=graph delta=true base_root=a new_root=b key=id\n',
      'GCF profile=generic pack_root=r key=id\n## t [1]{@id}\n1\n', // not a delta
      'GCF profile=generic delta=true base_root=a new_root=b key=id\n## added [2]{@id,x}\n1|2\n', // truncated
      'GCF profile=generic delta=true base_root=a new_root=b key=id\n## added [1]{@id,x}\n1\n', // wrong cell count
      'GCF profile=generic delta=true base_root=a new_root=b key=id\n## bogus [1]{@id}\n1\n', // unknown section
      'GCF profile=generic delta=true base_root=a new_root=b key=id\n## added [01]{@id,x}\n1|2\n', // bad count
    ];
    for (const wire of cases) {
      expect(() => decodeGenericDelta(wire)).toThrow();
    }
  });
});
