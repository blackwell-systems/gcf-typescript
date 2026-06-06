import { decode } from './decode.js';

/**
 * Decode any GCF text (tabular or graph profile) back into a JS value.
 * Returns objects, arrays, and primitives matching the original structure.
 *
 * If the input starts with "GCF " (graph profile), falls back to decode()
 * and returns the Payload as a plain object.
 */
export function decodeGeneric(input: string): any {
  input = input.trimEnd();
  if (!input) return null;

  const lines = input.split('\n');

  // Graph profile fallback.
  if (lines[0].startsWith('GCF ')) {
    const p = decode(input);
    return {
      tool: p.tool,
      tokenBudget: p.tokenBudget,
      tokensUsed: p.tokensUsed,
      packRoot: p.packRoot ?? '',
      symbols: p.symbols.map(s => ({
        qualifiedName: s.qualifiedName,
        kind: s.kind,
        score: s.score,
        provenance: s.provenance,
        distance: s.distance,
      })),
      edges: p.edges.map(e => ({
        source: e.source,
        target: e.target,
        edgeType: e.edgeType,
        ...(e.status ? { status: e.status } : {}),
      })),
    };
  }

  const result: Record<string, any> = {};
  parseObject(lines, 0, 0, result);
  return result;
}

function parseObject(lines: string[], start: number, depth: number, out: Record<string, any>): number {
  const indent = '  '.repeat(depth);
  let i = start;

  while (i < lines.length) {
    const raw = lines[i].replace(/\r$/, '');
    if (raw === '' || raw.startsWith('# ')) { i++; continue; }

    if (depth > 0 && !raw.startsWith(indent)) break;

    const content = depth > 0 ? raw.slice(indent.length) : raw;

    // Skip _summary.
    if (content.startsWith('## _summary')) { i++; continue; }

    // Tabular array or section header.
    if (content.startsWith('## ')) {
      const header = content.slice(3);
      const bracketIdx = header.indexOf(' [');

      if (bracketIdx >= 0) {
        const name = header.slice(0, bracketIdx);
        const rest = header.slice(bracketIdx + 2);
        const closeBracket = rest.indexOf(']');

        if (closeBracket >= 0) {
          const afterBracket = rest.slice(closeBracket + 1);

          if (afterBracket.startsWith('{')) {
            // Tabular with fields.
            const fieldEnd = afterBracket.indexOf('}');
            if (fieldEnd >= 0) {
              const fields = afterBracket.slice(1, fieldEnd).split(',');
              i++;
              const [rows, consumed] = parseTabularRows(lines, i, depth, fields);
              out[name] = rows;
              i += consumed;
              continue;
            }
          } else {
            const countStr = rest.slice(0, closeBracket);
            if (countStr === '0') {
              out[name] = [];
              i++;
              continue;
            }
            // Non-uniform array.
            i++;
            const [items, consumed] = parseNonUniformArray(lines, i, depth);
            out[name] = items;
            i += consumed;
            continue;
          }
        }
      }

      // Plain section header.
      let name = header;
      const bi = name.indexOf(' [');
      if (bi >= 0) name = name.slice(0, bi);
      i++;
      const nested: Record<string, any> = {};
      const consumed = parseObject(lines, i, depth + 1, nested);
      out[name] = nested;
      i += consumed;
      continue;
    }

    // Inline primitive array: name[N]: val1,val2,...
    const bracketIdx = content.indexOf('[');
    if (bracketIdx > 0) {
      const colonIdx = content.indexOf(']: ');
      if (colonIdx > bracketIdx) {
        const name = content.slice(0, bracketIdx);
        const valsStr = content.slice(colonIdx + 3);
        out[name] = valsStr.split(',').map(v => parseValue(v.trim()));
        i++;
        continue;
      }
    }

    // Key=value.
    const eqIdx = content.indexOf('=');
    if (eqIdx > 0) {
      const key = content.slice(0, eqIdx);
      const val = content.slice(eqIdx + 1);
      out[key] = parseValue(val);
      i++;
      continue;
    }

    i++;
  }

  return i - start;
}

function parseTabularRows(lines: string[], start: number, depth: number, fields: string[]): [any[], number] {
  const indent = '  '.repeat(depth);
  const rows: any[] = [];
  let i = start;

  while (i < lines.length) {
    const raw = lines[i].replace(/\r$/, '');
    if (raw === '') { i++; continue; }

    const content = depth > 0 ? (raw.startsWith(indent) ? raw.slice(indent.length) : null) : raw;
    if (content === null) break;
    if (content.startsWith('## ')) break;
    if (content.startsWith('# ')) { i++; continue; }

    let rowData = content;
    let hasNested = false;
    if (rowData.startsWith('@')) {
      const sp = rowData.indexOf(' ');
      if (sp > 0) {
        rowData = rowData.slice(sp + 1);
        hasNested = true;
      }
    }

    const vals = rowData.split('|');
    const row: Record<string, any> = {};
    for (let j = 0; j < fields.length; j++) {
      row[fields[j]] = j < vals.length ? parseValue(vals[j]) : null;
    }

    i++;

    if (hasNested) {
      const nestedIndent = indent + '  ';
      while (i < lines.length) {
        const nl = lines[i].replace(/\r$/, '');
        if (!nl.startsWith(nestedIndent)) break;
        const nc = nl.slice(nestedIndent.length);

        if (nc.startsWith('.')) {
          const fieldName = nc.slice(1);
          i++;
          const nested: Record<string, any> = {};
          const consumed = parseObject(lines, i, depth + 2, nested);
          row[fieldName] = nested;
          i += consumed;
        } else {
          break;
        }
      }
    }

    rows.push(row);
  }

  return [rows, i - start];
}

function parseNonUniformArray(lines: string[], start: number, depth: number): [any[], number] {
  const indent = '  '.repeat(depth);
  const items: any[] = [];
  let i = start;

  while (i < lines.length) {
    const raw = lines[i].replace(/\r$/, '');
    if (raw === '') { i++; continue; }
    const content = depth > 0 ? (raw.startsWith(indent) ? raw.slice(indent.length) : null) : raw;
    if (content === null) break;
    if (content.startsWith('## ')) break;

    if (content.startsWith('@')) {
      const sp = content.indexOf(' ');
      if (sp > 0) {
        items.push(parseValue(content.slice(sp + 1)));
      }
      i++;
    } else {
      break;
    }
  }

  return [items, i - start];
}

function parseValue(s: string): any {
  if (s === '-') return null;
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === '""') return '';
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
  }
  const n = Number(s);
  if (!isNaN(n) && s !== '') return n;
  return s;
}
