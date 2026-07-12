/**
 * Generic-profile delta encoding (SPEC Section 10a).
 *
 * Full producer + consumer for keyed-row deltas over the generic profile,
 * byte-for-byte interoperable with gcf-go and gcf-python. Delta is opt-in and
 * bilateral; the existing encodeGeneric path is unchanged.
 */

import { createHash } from 'node:crypto';
import {
  formatNumber,
  formatScalar,
  formatKey,
  quoteString,
  parseScalar,
  parseQuotedString,
  splitRespectingQuotes,
} from './scalar.js';

const PIPE = 0x7c; // '|'

/**
 * A keyed record set: the unit generic-profile delta operates on (Section 10a).
 * Rows are order-agnostic (set semantics); fields carries the declared column
 * order for the wire form; key names the identity column (the `@id` / `key=`);
 * name is the tabular section name for a full payload.
 */
export interface GenericSet {
  name?: string;
  key: string;
  fields: string[];
  rows: Array<Record<string, unknown>>;
}

/** A diff between two GenericSets (computed by diffGenericSets or supplied directly). */
export interface GenericDeltaPayload {
  tool?: string;
  key: string;
  fields: string[];
  baseRoot: string;
  newRoot: string;
  added: Array<Record<string, unknown>>;
  changed: Array<Record<string, unknown>>;
  removed: unknown[]; // identity values
  deltaTokens?: number;
  fullTokens?: number;
}

/** Compare two strings by UTF-8 byte order, matching Go's sort.Strings. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

/**
 * Canonicalize one value for the pack-root record (Section 10a.3). Purpose-built
 * and deliberately decoupled from the wire cell encoder (formatScalar): it must be
 * collision-free and record-safe, not round-trippable.
 *   - Typed literals stay bare so they never collide with the strings that spell
 *     them: null is "-" (never a string), booleans are true/false, numbers are
 *     canonical (Section 2.3.1).
 *   - Strings are ALWAYS quoted, so (a) they can't collide with a typed literal
 *     ("-", "true", "123" all become quoted), and (b) a tab or newline inside a
 *     value is escaped and cannot break the tab/newline-delimited record.
 */
export function canonicalCell(v: unknown): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return formatNumber(v);
  if (typeof v === 'string') return quoteString(v);
  return quoteString(String(v));
}

/**
 * Compute the canonical pack root for a keyed set using the gcf-pack-root-v1
 * algorithm, generic profile (Section 10a.3). Two implementations given the same
 * logical set MUST produce the same result.
 */
export function genericPackRoot(s: GenericSet): string {
  const sortedFields = [...s.fields].sort(byteCompare);

  const records: string[] = s.rows.map((row) => {
    let r = 'R';
    for (const f of sortedFields) {
      r += '\t' + f + '\t' + canonicalCell(row[f]);
    }
    return r + '\n';
  });
  records.sort(byteCompare);

  const hash = createHash('sha256').update(records.join(''), 'utf8').digest('hex');
  return `sha256:${hash}`;
}

/** Build an identity -> row map, rejecting duplicate identities (Section 10a.1). */
function indexByKey(s: GenericSet): Map<string, Record<string, unknown>> {
  const m = new Map<string, Record<string, unknown>>();
  for (const row of s.rows) {
    const id = canonicalCell(row[s.key]);
    if (m.has(id)) {
      throw new Error(`delta_invalid: duplicate identity ${id} for key ${JSON.stringify(s.key)}`);
    }
    m.set(id, row);
  }
  return m;
}

function rowsEqual(a: Record<string, unknown>, b: Record<string, unknown>, fields: string[]): boolean {
  return fields.every((f) => canonicalCell(a[f]) === canonicalCell(b[f]));
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Compute the delta from base to next. This is the blessed producer path: it is
 * the single place that enforces the keyed-diff invariants (identity uniqueness,
 * added-not-in-base, changed-must-exist, whole-row replacement, unchanged rows
 * omitted). Added/changed/removed are sorted by identity for reproducible output
 * (Section 10a.6). Schema change or a missing key throws: the caller must then
 * send a full payload (Section 10a.7).
 */
export function diffGenericSets(base: GenericSet, next: GenericSet): GenericDeltaPayload {
  if (!next.key) throw new Error('delta_invalid: no identity key');
  if (next.key !== base.key || !sameStrings(base.fields, next.fields)) {
    throw new Error('delta_invalid: schema change (send full)');
  }
  const baseByID = indexByKey(base);
  const nextByID = indexByKey(next);

  const added: Array<Record<string, unknown>> = [];
  const changed: Array<Record<string, unknown>> = [];
  const removed: unknown[] = [];

  for (const [id, row] of nextByID) {
    const brow = baseByID.get(id);
    if (brow === undefined) {
      added.push(row);
    } else if (!rowsEqual(brow, row, next.fields)) {
      changed.push(row);
    }
    // equal rows are omitted (silence = "keep it", Section 10a.5)
  }
  for (const [id, brow] of baseByID) {
    if (!nextByID.has(id)) removed.push(brow[next.key]);
  }

  added.sort((a, b) => byteCompare(canonicalCell(a[next.key]), canonicalCell(b[next.key])));
  changed.sort((a, b) => byteCompare(canonicalCell(a[next.key]), canonicalCell(b[next.key])));
  removed.sort((a, b) => byteCompare(canonicalCell(a), canonicalCell(b)));

  return {
    key: next.key,
    fields: [...next.fields],
    baseRoot: genericPackRoot(base),
    newRoot: genericPackRoot(next),
    added,
    changed,
    removed,
  };
}

// --- producer-side wire encoding ---

function fieldDecl(fields: string[], key: string): string {
  return fields.map((f) => (f === key ? '@' + formatKey(f) : formatKey(f))).join(',');
}

function encodeRow(row: Record<string, unknown>, fields: string[]): string {
  return fields.map((f) => formatScalar(row[f], PIPE)).join('|');
}

/**
 * Emit a delta-participating full base payload: `key=` in the header, an
 * `@`-prefixed identity field in the declaration, pipe-separated rows.
 */
export function encodeGenericFull(s: GenericSet, tool: string): string {
  const name = s.name || 'rows';
  let out = 'GCF profile=generic';
  if (tool) out += ' tool=' + tool;
  out += ' pack_root=' + genericPackRoot(s) + ' key=' + s.key + '\n';
  out += `## ${name} [${s.rows.length}]{${fieldDecl(s.fields, s.key)}}\n`;
  for (const row of s.rows) {
    out += encodeRow(row, s.fields) + '\n';
  }
  return out;
}

/**
 * Serialize a delta payload (Section 10a.2). Sections are emitted in the
 * deterministic order added / changed / removed (Section 10a.6).
 */
export function encodeGenericDelta(d: GenericDeltaPayload): string {
  let out = 'GCF profile=generic';
  if (d.tool) out += ' tool=' + d.tool;
  out += ' delta=true base_root=' + d.baseRoot + ' new_root=' + d.newRoot + ' key=' + d.key;
  if (d.fullTokens && d.fullTokens > 0) {
    const savings = 100 * (1 - (d.deltaTokens ?? 0) / d.fullTokens);
    out += ` savings=${Math.round(savings)}%`;
  }
  out += '\n';

  if (d.added.length > 0) {
    out += `## added [${d.added.length}]{${fieldDecl(d.fields, d.key)}}\n`;
    for (const row of d.added) out += encodeRow(row, d.fields) + '\n';
  }
  if (d.changed.length > 0) {
    out += `## changed [${d.changed.length}]{${fieldDecl(d.fields, d.key)}}\n`;
    for (const row of d.changed) out += encodeRow(row, d.fields) + '\n';
  }
  if (d.removed.length > 0) {
    out += `## removed [${d.removed.length}]{@${d.key}}\n`;
    for (const idv of d.removed) out += formatScalar(idv, PIPE) + '\n';
  }
  return out;
}

/**
 * Apply a delta to a base set and verify the result hashes to expectedNewRoot
 * (Section 10a.5). Atomic: the whole payload is validated before any state
 * changes, and a mismatch leaves the base untouched.
 */
export function verifyGenericDelta(
  base: GenericSet,
  d: GenericDeltaPayload,
  expectedNewRoot: string,
): GenericSet {
  if (genericPackRoot(base) !== d.baseRoot) {
    throw new Error('base_mismatch: base root does not equal delta base_root');
  }
  const baseByID = indexByKey(base);

  // Validate the entire payload against the original base before mutating.
  for (const idv of d.removed) {
    if (!baseByID.has(canonicalCell(idv))) {
      throw new Error(`delta_invalid: removing identity ${canonicalCell(idv)} not in base`);
    }
  }
  for (const row of d.added) {
    if (baseByID.has(canonicalCell(row[d.key]))) {
      throw new Error(`delta_invalid: adding identity ${canonicalCell(row[d.key])} that already exists`);
    }
  }
  for (const row of d.changed) {
    if (!baseByID.has(canonicalCell(row[d.key]))) {
      throw new Error(`delta_invalid: changing identity ${canonicalCell(row[d.key])} not in base`);
    }
  }

  // Apply to a working copy.
  const work = new Map(baseByID);
  for (const idv of d.removed) work.delete(canonicalCell(idv));
  for (const row of d.added) work.set(canonicalCell(row[d.key]), row);
  for (const row of d.changed) work.set(canonicalCell(row[d.key]), row);

  const result: GenericSet = {
    name: base.name,
    key: base.key,
    fields: base.fields,
    rows: [...work.values()],
  };
  const got = genericPackRoot(result);
  if (got !== expectedNewRoot) {
    throw new Error(`root_mismatch: computed ${got}, expected ${expectedNewRoot}`);
  }
  return result;
}

// --- consumer-side wire parsing (Section 10a) ---

function parseHeaderFields(header: string): Record<string, string> {
  const m: Record<string, string> = {};
  for (const tok of header.trim().split(/\s+/)) {
    const i = tok.indexOf('=');
    if (i > 0) m[tok.slice(0, i)] = tok.slice(i + 1);
  }
  return m;
}

function parseCount(s: string): number {
  if (s === '0') return 0;
  if (!s.length || s[0] === '0') throw new Error(`delta_invalid: invalid count ${s}`);
  const n = parseInt(s, 10);
  if (isNaN(n) || String(n) !== s) throw new Error(`delta_invalid: invalid count ${s}`);
  return n;
}

/** Find the first '[' not inside a quoted string. */
function findBracketStart(s: string): number {
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) { escaped = false; continue; }
    if (s[i] === '\\' && inQuote) { escaped = true; continue; }
    if (s[i] === '"') { inQuote = !inQuote; continue; }
    if (s[i] === '[' && !inQuote) return i;
  }
  return -1;
}

/**
 * Parse a delta/full field declaration `{@id,total,...}`. Unlike splitFieldDecl it
 * accepts the `@`-prefixed identity field (Section 10a.1), returning the ordered
 * fields and the key field (the one that was `@`-marked).
 */
function splitDeltaFieldDecl(decl: string): { fields: string[]; keyField: string } {
  if (decl.length < 2 || decl[0] !== '{' || decl[decl.length - 1] !== '}') {
    throw new Error(`delta_invalid: invalid field declaration: ${decl}`);
  }
  const inner = decl.slice(1, -1);
  if (inner === '') return { fields: [], keyField: '' };
  const fields: string[] = [];
  let keyField = '';
  for (const raw of splitRespectingQuotes(inner, ',')) {
    let f = raw.trim();
    let isKey = false;
    if (f.startsWith('@')) { f = f.slice(1); isKey = true; }
    if (f.length >= 2 && f[0] === '"' && f[f.length - 1] === '"') {
      f = parseQuotedString(f);
    }
    if (isKey) keyField = f;
    fields.push(f);
  }
  return { fields, keyField };
}

/**
 * Parse the content after `## ` of a delta/full section, e.g.
 * `added [1]{@id,total,status,customer}` or `orders [3]{@id,...}` or `removed [1]{@id}`.
 */
function parseSectionHeader(content: string): {
  name: string;
  count: number;
  fields: string[];
  keyField: string;
} {
  const bi = findBracketStart(content);
  if (bi < 0) throw new Error(`delta_invalid: section header without count: ${content}`);
  const name = content.slice(0, bi).trim();
  const rest = content.slice(bi); // "[N]{...}"
  if (rest.length === 0 || rest[0] !== '[') {
    throw new Error(`delta_invalid: malformed section header: ${content}`);
  }
  const close = rest.indexOf(']');
  if (close < 0) throw new Error(`delta_invalid: unterminated count: ${content}`);
  const count = parseCount(rest.slice(1, close));
  const { fields, keyField } = splitDeltaFieldDecl(rest.slice(close + 1));
  return { name, count, fields, keyField };
}

function parseRow(line: string, fields: string[]): Record<string, unknown> {
  const cells = splitRespectingQuotes(line, '|');
  if (cells.length !== fields.length) {
    throw new Error(`delta_invalid: row has ${cells.length} cells, expected ${fields.length}: ${line}`);
  }
  const row: Record<string, unknown> = {};
  fields.forEach((f, i) => { row[f] = parseScalar(cells[i], true); });
  return row;
}

/**
 * Parse a delta-participating full base payload into a GenericSet, and return the
 * declared pack_root (Section 10a).
 */
export function decodeGenericFull(text: string): { set: GenericSet; packRoot: string } {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length === 0) throw new Error('empty payload');
  const hdr = parseHeaderFields(lines[0]);
  if (hdr.profile !== 'generic') throw new Error('not a generic payload');

  const set: GenericSet = { key: hdr.key ?? '', fields: [], rows: [] };
  let i = 1;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('## ')) { i++; continue; }
    const { name, count, fields, keyField } = parseSectionHeader(line.slice(3));
    set.name = name;
    set.fields = fields;
    if (!set.key) set.key = keyField;
    i++;
    for (let j = 0; j < count; j++) {
      if (i >= lines.length) throw new Error('delta_invalid: fewer rows than declared count');
      set.rows.push(parseRow(lines[i], fields));
      i++;
    }
  }
  return { set, packRoot: hdr.pack_root ?? '' };
}

/**
 * Parse a delta payload into a GenericDeltaPayload (Section 10a.2). The result can
 * be applied with verifyGenericDelta.
 */
export function decodeGenericDelta(text: string): GenericDeltaPayload {
  const lines = text.replace(/\n+$/, '').split('\n');
  if (lines.length === 0) throw new Error('empty payload');
  const hdr = parseHeaderFields(lines[0]);
  if (hdr.profile !== 'generic') throw new Error('not a generic payload');
  if (hdr.delta !== 'true') throw new Error('not a delta payload');

  const d: GenericDeltaPayload = {
    tool: hdr.tool,
    key: hdr.key ?? '',
    fields: [],
    baseRoot: hdr.base_root ?? '',
    newRoot: hdr.new_root ?? '',
    added: [],
    changed: [],
    removed: [],
  };

  let i = 1;
  let fieldsSet = false;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('## ')) { i++; continue; }
    const { name, count, fields, keyField } = parseSectionHeader(line.slice(3));
    if (!d.key && keyField) d.key = keyField;
    if (!fieldsSet && (name === 'added' || name === 'changed')) {
      d.fields = fields;
      fieldsSet = true;
    }
    i++;
    if (name === 'added' || name === 'changed') {
      const rows: Array<Record<string, unknown>> = [];
      for (let j = 0; j < count; j++) {
        if (i >= lines.length) throw new Error(`delta_invalid: fewer rows than declared count in ## ${name}`);
        rows.push(parseRow(lines[i], fields));
        i++;
      }
      if (name === 'added') d.added = rows;
      else d.changed = rows;
    } else if (name === 'removed') {
      for (let j = 0; j < count; j++) {
        if (i >= lines.length) throw new Error('delta_invalid: fewer identities than declared count in ## removed');
        d.removed.push(parseScalar(lines[i], true));
        i++;
      }
    } else {
      throw new Error(`delta_invalid: unknown delta section ${name}`);
    }
  }
  return d;
}
