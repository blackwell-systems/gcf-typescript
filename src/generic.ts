/**
 * Generic encoder: converts any JS value into GCF v2.0 generic profile.
 */
import { formatScalar, formatKey, ATTACHMENT } from './scalar.js';

function indent(depth: number): string {
  return '  '.repeat(depth);
}

export function encodeGeneric(data: unknown): string {
  let out = 'GCF profile=generic\n';
  out += encodeRootValue(data);
  return out;
}

function encodeRootValue(v: unknown): string {
  if (v === null || v === undefined) return '=-\n';
  if (Array.isArray(v)) return encodeRootArray(v);
  if (typeof v === 'object') return encodeObject(v as Record<string, unknown>, 0);
  return `=${formatScalar(v, 0)}\n`;
}

function encodeObject(obj: Record<string, unknown>, depth: number): string {
  const prefix = indent(depth);
  let out = '';
  for (const key of Object.keys(obj)) {
    const value = obj[key];
    const fk = formatKey(key);
    if (Array.isArray(value)) {
      out += encodeNamedArray(fk, value, depth);
    } else if (typeof value === 'object' && value !== null) {
      out += `${prefix}## ${fk}\n`;
      out += encodeObject(value as Record<string, unknown>, depth + 1);
    } else {
      out += `${prefix}${fk}=${formatScalar(value, 0)}\n`;
    }
  }
  return out;
}

function encodeRootArray(arr: unknown[]): string {
  if (arr.length === 0) return '## [0]\n';
  if (allPrimitives(arr)) {
    const vals = arr.map(v => formatScalar(v, 0x2c));
    return `## [${arr.length}]: ${vals.join(',')}\n`;
  }
  const fields = tabularFields(arr);
  if (fields) return encodeTabular('## ', arr, fields, 0);
  return encodeExpanded('## ', arr, 0);
}

function encodeNamedArray(name: string, arr: unknown[], depth: number): string {
  const prefix = indent(depth);
  if (arr.length === 0) return `${prefix}## ${name} [0]\n`;
  if (allPrimitives(arr)) {
    const vals = arr.map(v => formatScalar(v, 0x2c));
    return `${prefix}${name}[${arr.length}]: ${vals.join(',')}\n`;
  }
  const fields = tabularFields(arr);
  if (fields) return encodeTabular(`${prefix}## ${name} `, arr, fields, depth);
  return encodeExpanded(`${prefix}## ${name} `, arr, depth);
}

function tabularFields(arr: unknown[]): string[] | null {
  if (arr.length === 0) return null;
  const fieldOrder: string[] = [];
  const seen = new Set<string>();
  for (const item of arr) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    for (const k of Object.keys(item as Record<string, unknown>)) {
      if (!seen.has(k)) { fieldOrder.push(k); seen.add(k); }
    }
  }
  return fieldOrder.length > 0 ? fieldOrder : null;
}

function encodeTabular(headerPrefix: string, arr: unknown[], fields: string[], depth: number): string {
  const prefix = indent(depth);
  const fmtFields = fields.map(f => formatKey(f));
  let out = `${headerPrefix}[${arr.length}]{${fmtFields.join(',')}}\n`;

  for (let i = 0; i < arr.length; i++) {
    const obj = arr[i] as Record<string, unknown>;
    const cells: string[] = [];
    const attachments: { name: string; value: unknown }[] = [];
    let rowHasAttachment = false;

    for (const f of fields) {
      if (!(f in obj)) { cells.push('~'); continue; }
      const v = obj[f];
      if (v === null || v === undefined) { cells.push('-'); continue; }
      if (typeof v === 'object') {
        cells.push('^');
        attachments.push({ name: f, value: v });
        rowHasAttachment = true;
      } else {
        cells.push(formatScalar(v, 0x7c));
      }
    }

    const row = cells.join('|');
    if (rowHasAttachment) {
      out += `${prefix}@${i} ${row}\n`;
    } else {
      out += `${prefix}${row}\n`;
    }

    for (const att of attachments) {
      const attPrefix = prefix + '  ';
      const fk = formatKey(att.name);
      if (Array.isArray(att.value)) {
        out += encodeAttachmentArray(attPrefix, fk, att.value as unknown[], depth + 2);
      } else {
        out += `${attPrefix}.${fk} {}\n`;
        out += encodeObject(att.value as Record<string, unknown>, depth + 2);
      }
    }
  }
  return out;
}

function encodeAttachmentArray(attPrefix: string, fk: string, arr: unknown[], depth: number): string {
  if (arr.length === 0) return `${attPrefix}.${fk} [0]\n`;
  if (allPrimitives(arr)) {
    const vals = arr.map(v => formatScalar(v, 0x2c));
    return `${attPrefix}.${fk} [${arr.length}]: ${vals.join(',')}\n`;
  }
  const fields = tabularFields(arr);
  if (fields) return encodeTabular(`${attPrefix}.${fk} `, arr, fields, depth);
  return encodeExpanded(`${attPrefix}.${fk} `, arr, depth);
}

function encodeExpanded(headerPrefix: string, arr: unknown[], depth: number): string {
  const prefix = indent(depth);
  let out = `${headerPrefix}[${arr.length}]\n`;
  for (let i = 0; i < arr.length; i++) {
    const item = arr[i];
    if (Array.isArray(item)) {
      out += encodeExpandedArrayItem(prefix, i, item, depth);
    } else if (typeof item === 'object' && item !== null) {
      out += `${prefix}@${i} {}\n`;
      out += encodeObject(item as Record<string, unknown>, depth + 1);
    } else {
      out += `${prefix}@${i} =${formatScalar(item, 0)}\n`;
    }
  }
  return out;
}

function encodeExpandedArrayItem(prefix: string, idx: number, arr: unknown[], depth: number): string {
  if (arr.length === 0) return `${prefix}@${idx} [0]\n`;
  if (allPrimitives(arr)) {
    const vals = arr.map(v => formatScalar(v, 0x2c));
    return `${prefix}@${idx} [${arr.length}]: ${vals.join(',')}\n`;
  }
  const fields = tabularFields(arr);
  if (fields) return encodeTabular(`${prefix}@${idx} `, arr, fields, depth + 1);
  return encodeExpanded(`${prefix}@${idx} `, arr, depth + 1);
}

function allPrimitives(arr: unknown[]): boolean {
  return arr.every(v => typeof v !== 'object' || v === null);
}
