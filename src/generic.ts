/**
 * Generic encoder: converts any JS value into GCF tabular format.
 */

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const s = String(value);
  if (s.includes('|') || s.includes('\n') || s === '') return JSON.stringify(s);
  return s;
}

function indent(depth: number): string {
  return '  '.repeat(depth);
}

function isUniformObjectArray(arr: unknown[]): boolean {
  if (arr.length === 0) return false;
  const objects = arr.filter(
    (item): item is Record<string, unknown> =>
      typeof item === 'object' && item !== null && !Array.isArray(item),
  );
  if (objects.length !== arr.length) return false;

  const referenceKeys = Object.keys(objects[0]).sort().join(',');
  const sampleSize = Math.min(5, objects.length);
  const refSet = new Set(Object.keys(objects[0]));

  for (let i = 1; i < sampleSize; i++) {
    const keys = Object.keys(objects[i]);
    const currentSet = new Set(keys);
    // 70% overlap check.
    const union = new Set([...refSet, ...currentSet]);
    const intersection = [...refSet].filter((k) => currentSet.has(k));
    if (intersection.length / union.size < 0.7) return false;
  }

  return true;
}

function encodeArray(
  arr: unknown[],
  name: string,
  lines: string[],
  depth: number,
): void {
  const prefix = indent(depth);

  if (isUniformObjectArray(arr)) {
    const objects = arr as Record<string, unknown>[];

    // Collect all keys across items.
    const allKeys = new Set<string>();
    for (const obj of objects) {
      for (const k of Object.keys(obj)) allKeys.add(k);
    }

    // Separate primitive fields from nested fields.
    const primitiveFields: string[] = [];
    const nestedFields: string[] = [];
    for (const key of allKeys) {
      const sample = objects.find((o) => o[key] !== undefined)?.[key];
      if (
        typeof sample === 'object' &&
        sample !== null
      ) {
        nestedFields.push(key);
      } else {
        primitiveFields.push(key);
      }
    }

    lines.push(`${prefix}## ${name} [${arr.length}]{${primitiveFields.join(',')}}`);

    if (nestedFields.length === 0) {
      // Pure flat rows: no @id prefix.
      for (const obj of objects) {
        const vals = primitiveFields.map((f) => formatValue(obj[f]));
        lines.push(`${prefix}${vals.join('|')}`);
      }
    } else {
      // Rows with nested fields: @N prefix.
      for (let i = 0; i < objects.length; i++) {
        const obj = objects[i];
        const vals = primitiveFields.map((f) => formatValue(obj[f]));
        lines.push(`${prefix}@${i} ${vals.join('|')}`);
        for (const nk of nestedFields) {
          const nv = obj[nk];
          if (nv === undefined || nv === null) continue;
          if (Array.isArray(nv)) {
            encodeArray(nv, nk, lines, depth + 1);
          } else if (typeof nv === 'object') {
            encodeObject(nv as Record<string, unknown>, nk, lines, depth + 1);
          }
        }
      }
    }
  } else {
    // Non-uniform array.
    lines.push(`${prefix}## ${name} [${arr.length}]`);
    for (let i = 0; i < arr.length; i++) {
      const item = arr[i];
      if (typeof item === 'object' && item !== null && !Array.isArray(item)) {
        lines.push(`${prefix}@${i}`);
        encodeObject(item as Record<string, unknown>, null, lines, depth + 1);
      } else {
        lines.push(`${prefix}@${i} ${formatValue(item)}`);
      }
    }
  }
}

function encodeObject(
  obj: Record<string, unknown>,
  name: string | null,
  lines: string[],
  depth: number,
): void {
  const prefix = indent(depth);

  if (name !== null) {
    lines.push(`${prefix}## ${name}`);
  }

  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value)) {
      encodeArray(value, key, lines, depth);
    } else if (typeof value === 'object' && value !== null) {
      encodeObject(value as Record<string, unknown>, key, lines, depth + 1);
    } else {
      lines.push(`${prefix}${key}=${formatValue(value)}`);
    }
  }
}

/**
 * Encode any JS value into GCF tabular format.
 */
export function encodeGeneric(data: unknown): string {
  // Primitives.
  if (data === null || data === undefined || typeof data !== 'object') {
    return String(data);
  }

  const lines: string[] = [];

  if (Array.isArray(data)) {
    encodeArray(data, 'root', lines, 0);
  } else {
    encodeObject(data as Record<string, unknown>, null, lines, 0);
  }

  return lines.join('\n') + '\n';
}
