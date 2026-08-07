/**
 * Generic encoder: converts any JS value into GCF generic profile.
 */
import { formatScalar, formatKey, ATTACHMENT } from './scalar.js';

function indent(depth: number): string {
  return '  '.repeat(depth);
}

// ── Object accessors (Map- and plain-object-aware) ────────────────────────
// A JSON object reaches the encoder either as a Map (from parseJSONOrdered,
// which preserves first-observed key order including integer-like keys per
// SPEC 7.4.3) or as a plain object (from JSON.parse or a JS caller). These
// helpers read either representation so the encoder stays representation-
// agnostic; a Map preserves insertion order for every key, a plain object
// preserves it for all keys except integer-index-like ones (a JS quirk).

/** True if v is a JSON object (Map or plain non-array object), not an array/null. */
function isObject(v: unknown): boolean {
  if (v === null || typeof v !== 'object') return false;
  if (Array.isArray(v)) return false;
  return true;
}

/** Keys of a JSON object in iteration order. */
function objKeys(v: unknown): string[] {
  if (v instanceof Map) return Array.from(v.keys());
  return Object.keys(v as Record<string, unknown>);
}

/** Value for a key, or undefined if absent. */
function objGet(v: unknown, k: string): unknown {
  if (v instanceof Map) return v.get(k);
  return (v as Record<string, unknown>)[k];
}

/** True if the object has its own entry for the key. */
function objHas(v: unknown, k: string): boolean {
  if (v instanceof Map) return v.has(k);
  return Object.prototype.hasOwnProperty.call(v as Record<string, unknown>, k);
}

/** [key, value] entries in iteration order. */
function objEntries(v: unknown): [string, unknown][] {
  if (v instanceof Map) return Array.from(v.entries());
  return Object.entries(v as Record<string, unknown>);
}

/** Options for controlling generic encoding behavior. */
export interface GenericOptions {
  /** When true, disables promotion of fixed-shape nested objects to path
   *  columns (e.g. "customer>name"). Nested objects use attachment syntax
   *  instead. Open-weight models currently comprehend the expanded form
   *  better; this gap is expected to close. */
  noFlatten?: boolean;
}

export function encodeGeneric(data: unknown, opts?: GenericOptions): string {
  let out = 'GCF profile=generic\n';
  out += encodeRootValue(data, opts);
  return out;
}

function encodeRootValue(v: unknown, opts?: GenericOptions): string {
  if (v === null || v === undefined) return '=-\n';
  if (Array.isArray(v)) return encodeRootArray(v, opts);
  if (isObject(v)) {
    const km = keyedMapEligible(v);
    if (km) return encodeKeyedMap('', false, km, 0, opts);
    return encodeObject(v, 0, opts);
  }
  return `=${formatScalar(v, 0)}\n`;
}

function encodeObject(obj: unknown, depth: number, opts?: GenericOptions): string {
  const prefix = indent(depth);
  let out = '';
  for (const [key, value] of objEntries(obj)) {
    const fk = formatKey(key);
    if (Array.isArray(value)) {
      out += encodeNamedArray(fk, value, depth, opts);
    } else if (isObject(value)) {
      const km = keyedMapEligible(value);
      if (km) {
        out += encodeKeyedMap(key, true, km, depth, opts);
        continue;
      }
      out += `${prefix}## ${fk}\n`;
      out += encodeObject(value, depth + 1, opts);
    } else {
      out += `${prefix}${fk}=${formatScalar(value, 0)}\n`;
    }
  }
  return out;
}

// ── Keyed map encoding (tabular, SPEC 7.2a) ───────────────────────────────

interface KeyedMap {
  keys: string[];         // ordered member keys
  values: unknown[];      // corresponding member value objects
  valueFields: string[];  // ordered value-field union
  keyLabel: string;       // key-column label ("key", or "_key" on collision)
}

// keyedMapEligible reports whether an object is a keyed map of objects that
// should render as a keyed table `## [N:]{key,...}` (SPEC 7.2a.1). It returns
// the ordered member keys, the value objects, the value-field union, and the
// key-column label, or null when the object is not eligible.
function keyedMapEligible(m: unknown): KeyedMap | null {
  const keys = objKeys(m);

  // A keyed map requires at least two members: the form factors the shared
  // value fields into one header, which only pays off across multiple members.
  // A single-member map yields a one-row table the same size as a section, so
  // keying it would change canonical output for every nested single-member
  // object (e.g. {"data":{...}} wrappers) with no benefit (SPEC 7.2a.1).
  if (keys.length < 2) return null;

  const values: unknown[] = [];
  const valueFields: string[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    const v = objGet(m, k);
    // Every value must be a non-array object; build the ordered field union.
    if (!isObject(v)) return null;
    values.push(v);
    for (const f of objKeys(v)) {
      if (!seen.has(f)) { seen.add(f); valueFields.push(f); }
    }
  }
  // All-empty value objects have an empty field union and are not eligible.
  if (valueFields.length === 0) return null;

  // A keyed header needs at least one value field that can be a tabular column.
  // A field name containing ">" cannot be a column (SPEC 7.4.6.1.4); if every
  // value field contains ">", the keyed form would have only the key column,
  // which is invalid. Such a map uses Section 7.2 section encoding instead.
  if (!valueFields.some(f => !f.includes('>'))) return null;

  // Key-column label: "key", made unique by prepending "_" on collision.
  let keyLabel = 'key';
  while (valueFields.includes(keyLabel)) keyLabel = '_' + keyLabel;

  return { keys, values, valueFields, keyLabel };
}

// encodeKeyedMap emits a keyed table for a map of objects. named distinguishes
// an anonymous root keyed map (`## `) from a named member whose name may itself
// be the empty string (`## ""`), which formatKey quotes so it round-trips as a
// distinct level rather than collapsing into the anonymous root form.
function encodeKeyedMap(name: string, named: boolean, km: KeyedMap, depth: number, opts?: GenericOptions): string {
  const prefix = indent(depth);
  const headerPrefix = named ? `${prefix}## ${formatKey(name)} ` : `${prefix}## `;
  return encodeKeyedMapWithPrefix(headerPrefix, km, depth, opts);
}

// encodeKeyedMapWithPrefix emits `<headerPrefix>[N:]{...}` and the keyed rows,
// reusing encodeTabular. It augments each value object with the key column and
// routes through the tabular encoder with the keyed bracket, so nested-value
// handling (flatten/inline/attachment/null/absent) is inherited unchanged.
function encodeKeyedMapWithPrefix(headerPrefix: string, km: KeyedMap, depth: number, opts?: GenericOptions): string {
  const fields = [km.keyLabel, ...km.valueFields];
  const arr = km.keys.map((k, i) => {
    // Key column first so it decodes as cell 0; value fields follow in union
    // order. A Map keeps that order even for integer-like field names.
    const aug = new Map<string, unknown>();
    aug.set(km.keyLabel, k);
    const vo = km.values[i];
    for (const kk of objKeys(vo)) aug.set(kk, objGet(vo, kk));
    return aug;
  });
  return encodeTabular(headerPrefix, arr, fields, depth, opts, true);
}

function encodeRootArray(arr: unknown[], opts?: GenericOptions): string {
  if (arr.length === 0) return '## [0]\n';
  if (allPrimitives(arr)) {
    const vals = arr.map(v => formatScalar(v, 0x2c));
    return `## [${arr.length}]: ${vals.join(',')}\n`;
  }
  const fields = tabularFields(arr);
  if (fields) return encodeTabular('## ', arr, fields, 0, opts);
  return encodeExpanded('## ', arr, 0, opts);
}

function encodeNamedArray(name: string, arr: unknown[], depth: number, opts?: GenericOptions): string {
  const prefix = indent(depth);
  if (arr.length === 0) return `${prefix}## ${name} [0]\n`;
  if (allPrimitives(arr)) {
    const vals = arr.map(v => formatScalar(v, 0x2c));
    return `${prefix}${name}[${arr.length}]: ${vals.join(',')}\n`;
  }
  const fields = tabularFields(arr);
  if (fields) return encodeTabular(`${prefix}## ${name} `, arr, fields, depth, opts);
  return encodeExpanded(`${prefix}## ${name} `, arr, depth, opts);
}

function tabularFields(arr: unknown[]): string[] | null {
  if (arr.length === 0) return null;
  const fieldOrder: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (!isObject(item)) return null;
    for (const k of objKeys(item)) {
      if (!seen.has(k)) { fieldOrder.push(k); seen.add(k); }
    }
  }
  return fieldOrder.length > 0 ? fieldOrder : null;
}

/** Check if a field is eligible for inline schema: all rows have same flat object shape with 3+ keys. */
function inlineSchemaFields(arr: unknown[], fieldName: string): string[] | null {
  // First row must have the field.
  const first = arr[0];
  if (first === undefined || !objHas(first, fieldName)) return null;
  const firstVal = objGet(first, fieldName);
  if (!isObject(firstVal)) return null;

  let canonicalKeys: string[] | null = null;
  for (const item of arr) {
    if (!objHas(item, fieldName) || objGet(item, fieldName) === null || objGet(item, fieldName) === undefined) continue;
    const v = objGet(item, fieldName);
    if (!isObject(v)) return null;
    const keys = objKeys(v);
    // All values must be scalars.
    for (const k of keys) {
      const val = objGet(v, k);
      if (val !== null && val !== undefined && typeof val === 'object') return null;
    }
    if (!canonicalKeys) {
      canonicalKeys = keys;
    } else {
      if (keys.length !== canonicalKeys.length) return null;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== canonicalKeys[i]) return null;
      }
    }
  }
  if (!canonicalKeys || canonicalKeys.length < 3) return null;
  return canonicalKeys;
}

/** Check if array attachment has same tabular schema across all rows (first row must have it). All values must be scalars. */
function sharedArraySchema(arr: unknown[], fieldName: string): string[] | null {
  const first = arr[0];
  if (first === undefined || !objHas(first, fieldName)) return null;
  const firstVal = objGet(first, fieldName);
  if (!Array.isArray(firstVal)) return null;

  let canonicalFields: string[] | null = null;
  for (const item of arr) {
    if (!objHas(item, fieldName) || objGet(item, fieldName) === null || objGet(item, fieldName) === undefined) continue;
    const v = objGet(item, fieldName);
    if (!Array.isArray(v)) return null;
    const fields = tabularFields(v);
    if (!fields) return null;
    // All values must be scalars.
    for (const arrItem of v) {
      if (!isObject(arrItem)) return null;
      for (const val of objKeys(arrItem).map(k => objGet(arrItem, k))) {
        if (val !== null && val !== undefined && typeof val === 'object') return null;
      }
    }
    if (!canonicalFields) {
      canonicalFields = fields;
    } else {
      if (fields.length !== canonicalFields.length) return null;
      for (let i = 0; i < fields.length; i++) {
        if (fields[i] !== canonicalFields[i]) return null;
      }
    }
  }
  return canonicalFields;
}

// ── Nested object flattening (v3.2) ──────────────────────────────────────

interface FlatLeaf {
  path: string;     // ">" separated path (e.g. "customer>name")
  keys: string[];   // key chain to traverse from row object
}

// Keys that would pollute Object.prototype if used as a flatten path segment.
// An object carrying one of these is never flattened; it round-trips whole.
function isUnsafeKey(k: string): boolean {
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

function analyzeFlattenable(arr: unknown[], fieldName: string, parentPath: string): FlatLeaf[] | null {
  // Field names containing ">" cannot be flattened (would create ambiguous paths).
  if (fieldName === '' || fieldName.includes('>')) return null; // empty/'>' key -> ambiguous path (SPEC 7.4.6.1.3)
  // A Map preserves first-observed key order (including integer-like keys), so the
  // flattened path columns come out in insertion order per SPEC 7.4.3; a plain
  // object would reorder integer-index-like keys ahead of the rest.
  let canonicalShape: Map<string, 'scalar' | 'nested'> | null = null;

  for (const item of arr) {
    if (!objHas(item, fieldName) || objGet(item, fieldName) === undefined) continue;
    if (objGet(item, fieldName) === null) {
      // A nested (non-top-level) null cannot be flattened losslessly: its leaves would
      // encode as absent ("~") and unflatten back to a missing key, not null. Bail to
      // the whole-object (attachment) path. A top-level null is fine: it emits "-" and
      // reconstructs via the all-null rule (Section 7.4.6 / fixture 013), so just skip
      // the row from shape analysis.
      if (parentPath !== '') return null;
      continue;
    }
    const v = objGet(item, fieldName);
    if (!isObject(v)) return null;

    const keys = objKeys(v);

    if (!canonicalShape) {
      canonicalShape = new Map<string, 'scalar' | 'nested'>();
      for (const k of keys) {
        // Reject empty/'>' (ambiguous path, SPEC 7.4.6.1.3) and prototype-pollution
        // keys outright (never flattened; round-trip whole).
        if (k === '' || k.includes('>') || isUnsafeKey(k)) return null;
        const val = objGet(v, k);
        if (val !== null && val !== undefined && typeof val === 'object' && !Array.isArray(val)) {
          canonicalShape.set(k, 'nested');
        } else if (Array.isArray(val)) {
          return null;
        } else {
          canonicalShape.set(k, 'scalar');
        }
      }
    } else {
      if (keys.length !== canonicalShape.size) return null;
      for (const k of keys) {
        if (!canonicalShape.has(k)) return null;
        const val = objGet(v, k);
        const expected = canonicalShape.get(k);
        if (expected === 'scalar') {
          if (val !== null && val !== undefined && typeof val === 'object') return null;
        } else if (expected === 'nested') {
          if (val !== null && val !== undefined) {
            if (typeof val !== 'object' || Array.isArray(val)) return null;
          }
        }
      }
    }
  }

  if (!canonicalShape) return null;

  const currentPath = parentPath ? parentPath + '>' + fieldName : fieldName;
  const parentKeys = parentPath ? [...parentPath.split('>'), fieldName] : [fieldName];

  const leaves: FlatLeaf[] = [];
  for (const [k, shape] of canonicalShape) {
    if (shape === 'scalar') {
      leaves.push({ path: currentPath + '>' + k, keys: [...parentKeys, k] });
    } else {
      const subArr = arr.map(item => {
        if (!objHas(item, fieldName) || objGet(item, fieldName) === null || objGet(item, fieldName) === undefined) return {};
        return objGet(item, fieldName);
      });
      const subLeaves = analyzeFlattenable(subArr as unknown[], k, currentPath);
      if (!subLeaves || subLeaves.length === 0) return null;
      leaves.push(...subLeaves);
    }
  }

  // Guard: reject if any row has non-null object with all-null leaves.
  if (leaves.length > 0) {
    for (const item of arr) {
      if (!objHas(item, fieldName) || objGet(item, fieldName) === null || objGet(item, fieldName) === undefined) continue;
      const allNull = leaves.every(leaf => {
        const val = resolveKeyChain(item, leaf.keys);
        return val.exists && val.value === null;
      });
      if (allNull) return null;
    }
  }

  return leaves;
}

function resolveKeyChain(item: unknown, keys: string[]): { value: unknown; exists: boolean } {
  if (keys.length === 0) return { value: undefined, exists: false };
  if (!isObject(item)) return { value: undefined, exists: false };
  if (!objHas(item, keys[0])) return { value: undefined, exists: false };
  let current: unknown = objGet(item, keys[0]);
  if (current === null || current === undefined) return { value: current, exists: true };
  for (let i = 1; i < keys.length; i++) {
    if (!isObject(current)) return { value: undefined, exists: false };
    if (!objHas(current, keys[i])) return { value: undefined, exists: false };
    current = objGet(current, keys[i]);
  }
  return { value: current, exists: true };
}

// ── End flattening helpers ───────────────────────────────────────────────

function encodeTabular(headerPrefix: string, arr: unknown[], fields: string[], depth: number, opts?: GenericOptions, keyed = false): string {
  const prefix = indent(depth);

  // Phase 0: Analyze fields for flattening.
  const flattenMap = new Map<string, FlatLeaf[]>();
  if (!opts?.noFlatten) {
    for (const f of fields) {
      const leaves = analyzeFlattenable(arr, f, '');
      if (leaves && leaves.length > 0) {
        flattenMap.set(f, leaves);
      }
    }
  }

  // Fields whose names contain ">" must not appear as tabular columns
  // because the decoder would interpret them as flattened path columns.
  // Track them for per-row attachment emission (spec rule 7.4.6.1.4).
  const gtFields = new Set<string>();
  for (const f of fields) {
    if (!flattenMap.has(f) && f.includes('>')) {
      gtFields.add(f);
    }
  }

  // Build expanded column list.
  type ColType = 'flat' | 'original';
  interface FlatColumn { headerName: string; colType: ColType; field: string; keys: string[]; }
  const columns: FlatColumn[] = [];
  for (const f of fields) {
    if (gtFields.has(f)) continue;
    const leaves = flattenMap.get(f);
    if (leaves) {
      for (const leaf of leaves) {
        columns.push({ headerName: formatKey(leaf.path), colType: 'flat', field: f, keys: leaf.keys });
      }
    } else {
      columns.push({ headerName: formatKey(f), colType: 'original', field: f, keys: [] });
    }
  }

  // If all fields were excluded (all contain ">"), fall back to expanded.
  if (columns.length === 0) {
    return encodeExpanded(headerPrefix, arr, depth, opts);
  }

  // Pre-compute inline schemas and shared array schemas (skip flattened fields).
  const inlineSchemas = new Map<string, string[]>();
  const sharedArrSchemas = new Map<string, string[]>();
  for (const f of fields) {
    if (flattenMap.has(f)) continue;
    const ifs = inlineSchemaFields(arr, f);
    if (ifs) inlineSchemas.set(f, ifs);
    const sas = sharedArraySchema(arr, f);
    if (sas) sharedArrSchemas.set(f, sas);
  }

  const headerFields = columns.map(c => c.headerName);
  const br = keyed ? ':]' : ']';
  let out = `${headerPrefix}[${arr.length}${br}{${headerFields.join(',')}}\n`;

  for (let i = 0; i < arr.length; i++) {
    const obj = arr[i];
    const cells: string[] = [];
    const attachments: { name: string; value: unknown; inline: boolean; inlineFields?: string[] }[] = [];
    let rowHasAttachment = false;

    for (const col of columns) {
      if (col.colType === 'flat') {
        // Resolve value via key chain.
        if (!objHas(obj, col.keys[0])) {
          cells.push('~');
        } else {
          // Check if top-level field is null.
          const topVal = objGet(obj, col.keys[0]);
          if (topVal === null || topVal === undefined) {
            cells.push(topVal === null ? '-' : '~');
          } else {
            const resolved = resolveKeyChain(obj, col.keys);
            if (!resolved.exists) {
              cells.push('~');
            } else if (resolved.value === null || resolved.value === undefined) {
              cells.push('-');
            } else {
              cells.push(formatScalar(resolved.value, 0x7c));
            }
          }
        }
        continue;
      }

      // Original (non-flattened) field.
      const f = col.field;
      if (!objHas(obj, f)) { cells.push('~'); continue; }
      const v = objGet(obj, f);
      if (v === null || v === undefined) { cells.push('-'); continue; }
      if (typeof v === 'object') {
        const ifs = inlineSchemas.get(f);
        if (ifs && !Array.isArray(v)) {
          if (i === 0) {
            const fmtIF = ifs.map(k => formatKey(k));
            cells.push(`^{${fmtIF.join(',')}}`);
          } else {
            cells.push('^');
          }
          attachments.push({ name: f, value: v, inline: true, inlineFields: ifs });
        } else {
          cells.push('^');
          attachments.push({ name: f, value: v, inline: false });
        }
        rowHasAttachment = true;
      } else {
        cells.push(formatScalar(v, 0x7c));
      }
    }

    // Emit fields with ">" in their names as per-row attachments.
    for (const f of fields) {
      if (!gtFields.has(f)) continue;
      if (!objHas(obj, f)) continue;
      rowHasAttachment = true;
      attachments.push({ name: f, value: objGet(obj, f), inline: false });
    }

    const row = cells.join('|');
    if (rowHasAttachment) {
      out += `${prefix}@${i} ${row}\n`;
    } else {
      out += `${prefix}${row}\n`;
    }

    for (const att of attachments) {
      const fk = formatKey(att.name);
      if (att.inline && att.inlineFields) {
        // Inline: single pipe-delimited row, no prefix, no indent.
        const vals = att.inlineFields.map(inf => {
          const val = objGet(att.value, inf);
          if (val === undefined) return '~';
          return formatScalar(val, 0x7c);
        });
        out += `${prefix}${vals.join('|')}\n`;
      } else if (Array.isArray(att.value)) {
        // Shared array schema: omit {fields} on subsequent rows.
        const sas = sharedArrSchemas.get(att.name);
        if (sas && i > 0) {
          out += encodeAttachmentArrayShared(prefix, fk, att.value as unknown[], depth + 2, sas, opts);
        } else {
          out += encodeAttachmentArray(prefix, fk, att.value as unknown[], depth + 2, opts);
        }
      } else if (isObject(att.value)) {
        const km = keyedMapEligible(att.value);
        if (km) {
          out += encodeKeyedMapWithPrefix(`${prefix}.${fk} `, km, depth + 2, opts);
        } else {
          out += `${prefix}.${fk} {}\n`;
          out += encodeObject(att.value, depth + 2, opts);
        }
      } else {
        // Scalar attachment (e.g. field names containing ">").
        if (att.value === null || att.value === undefined) {
          out += `${prefix}.${fk} =-\n`;
        } else {
          out += `${prefix}.${fk} =${formatScalar(att.value, 0)}\n`;
        }
      }
    }
  }
  return out;
}

function encodeAttachmentArray(attPrefix: string, fk: string, arr: unknown[], depth: number, opts?: GenericOptions): string {
  if (arr.length === 0) return `${attPrefix}.${fk} [0]\n`;
  if (allPrimitives(arr)) {
    const vals = arr.map(v => formatScalar(v, 0x2c));
    return `${attPrefix}.${fk} [${arr.length}]: ${vals.join(',')}\n`;
  }
  const fields = tabularFields(arr);
  if (fields) return encodeTabular(`${attPrefix}.${fk} `, arr, fields, depth, opts);
  return encodeExpanded(`${attPrefix}.${fk} `, arr, depth, opts);
}

function encodeAttachmentArrayShared(attPrefix: string, fk: string, arr: unknown[], depth: number, sharedFields: string[], opts?: GenericOptions): string {
  if (arr.length === 0) return `${attPrefix}.${fk} [0]\n`;
  if (allPrimitives(arr)) {
    const vals = arr.map(v => formatScalar(v, 0x2c));
    return `${attPrefix}.${fk} [${arr.length}]: ${vals.join(',')}\n`;
  }
  // Verify fields match shared schema.
  const fields = tabularFields(arr);
  if (fields && fields.length === sharedFields.length && fields.every((f, i) => f === sharedFields[i])) {
    // Omit {fields}, use shared schema.
    const prefix = indent(depth);
    let out = `${attPrefix}.${fk} [${arr.length}]\n`;
    for (const item of arr) {
      const cells = sharedFields.map(f => {
        if (!objHas(item, f)) return '~';
        const val = objGet(item, f);
        if (val === null || val === undefined) return '-';
        return formatScalar(val, 0x7c);
      });
      out += `${prefix}${cells.join('|')}\n`;
    }
    return out;
  }
  // Fields don't match: fall back to full encoding.
  return encodeAttachmentArray(attPrefix, fk, arr, depth, opts);
}

function encodeExpanded(headerPrefix: string, arr: unknown[], depth: number, opts?: GenericOptions): string {
  const prefix = indent(depth);
  let out = `${headerPrefix}[${arr.length}]\n`;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (Array.isArray(item)) {
      out += encodeExpandedArrayItem(prefix, i, item, depth, opts);
    } else if (isObject(item)) {
      const km = keyedMapEligible(item);
      if (km) {
        out += encodeKeyedMapWithPrefix(`${prefix}@${i} `, km, depth + 1, opts);
        continue;
      }
      out += `${prefix}@${i} {}\n`;
      out += encodeObject(item, depth + 1, opts);
    } else {
      out += `${prefix}@${i} =${formatScalar(item, 0)}\n`;
    }
  }
  return out;
}

function encodeExpandedArrayItem(prefix: string, idx: number, arr: unknown[], depth: number, opts?: GenericOptions): string {
  if (arr.length === 0) return `${prefix}@${idx} [0]\n`;
  if (allPrimitives(arr)) {
    const vals = arr.map(v => formatScalar(v, 0x2c));
    return `${prefix}@${idx} [${arr.length}]: ${vals.join(',')}\n`;
  }
  const fields = tabularFields(arr);
  if (fields) return encodeTabular(`${prefix}@${idx} `, arr, fields, depth + 1, opts);
  return encodeExpanded(`${prefix}@${idx} `, arr, depth + 1, opts);
}

function allPrimitives(arr: unknown[]): boolean {
  return arr.every(v => typeof v !== 'object' || v === null);
}
