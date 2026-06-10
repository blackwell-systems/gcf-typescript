import { decode } from './decode.js';
import {
  parseScalar, parseQuotedString, splitRespectingQuotes, splitFieldDecl,
  isBareKey, MISSING, ATTACHMENT,
} from './scalar.js';

/**
 * Decode GCF v2.0 generic or graph profile text into a JS value.
 */
export function decodeGeneric(input: string): any {
  input = input.trimEnd();
  if (!input) throw new Error('missing_header: empty input');

  const lines = input.split('\n');
  const header = lines[0].replace(/\r$/, '');
  if (!header.startsWith('GCF ')) throw new Error('missing_header: first line does not begin with GCF');

  const profile = parseHeaderProfile(header);

  if (profile === 'graph') {
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
        status: e.status ?? '',
      })),
    };
  }

  if (profile !== 'generic') throw new Error(`unknown_profile: ${profile}`);

  // Filter body.
  const contentLines: string[] = [];
  let summaryLine = '';
  let deferredSectionCount = 0;
  for (let i = 1; i < lines.length; i++) {
    const l = lines[i].replace(/\r$/, '');
    if (l === '') continue;
    // Tab check.
    for (let j = 0; j < l.length; j++) {
      if (l[j] === '\t') throw new Error('tab_indentation: tabs in leading whitespace');
      if (l[j] !== ' ') break;
    }
    const trimmed = l.trimStart();
    if (trimmed.startsWith('# ')) continue;
    if (trimmed.startsWith('##! ')) { summaryLine = trimmed; continue; }
    if (trimmed.startsWith('## ') && trimmed.includes('[?]')) deferredSectionCount++;
    contentLines.push(l);
  }

  // Validate ##! summary counts.
  if (summaryLine && deferredSectionCount > 0) {
    validateSummaryCounts(summaryLine, deferredSectionCount, contentLines);
  }

  if (contentLines.length === 0) return {};

  const first = contentLines[0].trimStart();

  // Root scalar.
  if (first.startsWith('=')) {
    if (contentLines.length > 1) throw new Error('trailing_characters: extra lines after root scalar');
    return parseScalar(first.slice(1), false);
  }

  // Root array.
  if (first.startsWith('## [')) {
    const [arr] = parseArrayFromHeader(contentLines, 0, 0, first.slice(3));
    return arr;
  }

  // Root object.
  const result: Record<string, any> = {};
  parseObjectBody(contentLines, 0, 0, result);
  return result;
}

function parseHeaderProfile(header: string): string {
  const parts = header.split(/\s+/);
  if (parts.length < 2) throw new Error('missing_profile');
  const seen = new Set<string>();
  let profile = '';
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq < 0) throw new Error(`malformed_header_field: ${parts[i]}`);
    const key = parts[i].slice(0, eq);
    if (seen.has(key)) throw new Error(`duplicate_header_field: ${key}`);
    seen.add(key);
    if (key === 'profile') profile = parts[i].slice(eq + 1);
  }
  if (!profile) throw new Error('missing_profile');
  return profile;
}

function parseObjectBody(lines: string[], start: number, depth: number, out: Record<string, any>): number {
  const ind = '  '.repeat(depth);
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    if (depth > 0 && !line.startsWith(ind)) break;
    const content = depth > 0 ? line.slice(ind.length) : line;
    if (content.length > 0 && content[0] === ' ') {
      throw new Error('invalid_indent: indentation increases by more than one level');
    }

    // Array section.
    if (content.startsWith('## ')) {
      const hdr = content.slice(3);
      const bi = hdr.indexOf(' [');
      if (bi >= 0) {
        const name = parseKeyFromHeader(hdr.slice(0, bi));
        checkDup(out, name);
        const [arr, consumed] = parseArrayFromHeader(lines, i, depth, hdr.slice(bi));
        out[name] = arr;
        i += consumed;
        continue;
      }
      const name = parseKeyFromHeader(hdr);
      checkDup(out, name);
      i++;
      const nested: Record<string, any> = {};
      const consumed = parseObjectBody(lines, i, depth + 1, nested);
      out[name] = nested;
      i += consumed;
      continue;
    }

    // Inline array.
    if (!content.startsWith('@') && !content.startsWith('##')) {
      const bracketIdx = content.indexOf('[');
      if (bracketIdx > 0) {
        const rest = content.slice(bracketIdx);
        const closeIdx = rest.indexOf(']');
        if (closeIdx >= 0) {
          const after = rest.slice(closeIdx + 1);
          if (after.startsWith(': ') || after === ':') {
            const name = parseKeyFromHeader(content.slice(0, bracketIdx));
            checkDup(out, name);
            const [arr] = parseArrayFromHeader(lines, i, depth, rest);
            out[name] = arr;
            i++;
            continue;
          }
        }
      }
    }

    // Key=value.
    const eqIdx = findKeyValueSplit(content);
    if (eqIdx > 0) {
      const name = parseKeyFromHeader(content.slice(0, eqIdx));
      checkDup(out, name);
      out[name] = parseScalar(content.slice(eqIdx + 1), false);
      i++;
      continue;
    }

    i++;
  }
  return i - start;
}

function findKeyValueSplit(s: string): number {
  if (!s.length) return -1;
  if (s[0] === '"') {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '"') return (i + 1 < s.length && s[i + 1] === '=') ? i + 1 : -1;
    }
    return -1;
  }
  return s.indexOf('=');
}

function parseKeyFromHeader(s: string): string {
  s = s.trim();
  if (s.length >= 2 && s[0] === '"') return parseQuotedString(s);
  return s;
}

function checkDup(obj: Record<string, any>, key: string): void {
  if (key in obj) throw new Error(`duplicate_key: ${key}`);
}

function parseArrayFromHeader(lines: string[], headerLine: number, depth: number, bracketPart: string): [any, number] {
  const bp = bracketPart.trimStart();
  if (!bp.startsWith('[')) throw new Error('invalid_count');
  const closeIdx = bp.indexOf(']');
  if (closeIdx < 0) throw new Error('invalid_count');

  const countStr = bp.slice(1, closeIdx);
  const afterBracket = bp.slice(closeIdx + 1);
  let count = -1;
  if (countStr !== '?') count = parseCount(countStr);

  if (count === 0 && !afterBracket.startsWith('{') && !afterBracket.startsWith(':')) {
    return [[], 1];
  }

  // Inline.
  if (afterBracket.startsWith(': ') || afterBracket === ':') {
    const valsStr = afterBracket.startsWith(': ') ? afterBracket.slice(2) : '';
    if (!valsStr) {
      if (count >= 0 && count !== 0) throw new Error(`count_mismatch: declared ${count}, got 0`);
      return [[], 1];
    }
    const vals = splitRespectingQuotes(valsStr, ',');
    if (count >= 0 && vals.length !== count) throw new Error(`count_mismatch: declared ${count}, got ${vals.length}`);
    return [vals.map(v => parseScalar(v.trim(), false)), 1];
  }

  // Tabular.
  if (afterBracket.startsWith('{')) {
    const braceEnd = findClosingBrace(afterBracket);
    if (braceEnd < 0) throw new Error('invalid field declaration');
    const fields = splitFieldDecl(afterBracket.slice(0, braceEnd + 1));
    const [rows, consumed] = parseTabularBody(lines, headerLine + 1, depth, fields, count);
    if (count >= 0 && rows.length !== count) throw new Error(`count_mismatch: declared ${count}, got ${rows.length}`);
    return [rows, consumed + 1];
  }

  // Expanded.
  const [items, consumed] = parseExpandedBody(lines, headerLine + 1, depth);
  if (count >= 0 && items.length !== count) throw new Error(`count_mismatch: declared ${count}, got ${items.length}`);
  return [items, consumed + 1];
}

function findClosingBrace(s: string): number {
  let inQuote = false, escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) { escaped = false; continue; }
    if (s[i] === '\\' && inQuote) { escaped = true; continue; }
    if (s[i] === '"') { inQuote = !inQuote; continue; }
    if (s[i] === '}' && !inQuote) return i;
  }
  return -1;
}

function parseTabularBody(lines: string[], start: number, depth: number, fields: string[], expectedCount: number): [any[], number] {
  const ind = '  '.repeat(depth);
  const rows: any[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const content = depth > 0 ? (line.startsWith(ind) ? line.slice(ind.length) : null) : line;
    if (content === null) break;
    if (content.startsWith('## ') || content.startsWith('##!')) break;

    if (content.length > 0 && content[0] === ' ') {
      const trimmed = content.trimStart();
      if (trimmed.startsWith('.')) throw new Error(`orphan_attachment: ${trimmed}`);
      break;
    }

    let rowData = content;
    let rowHasID = false;
    if (rowData.startsWith('@')) {
      const sp = rowData.indexOf(' ');
      if (sp > 0) { rowData = rowData.slice(sp + 1); rowHasID = true; }
    }

    const vals = splitRespectingQuotes(rowData, '|');
    if (vals.length !== fields.length) throw new Error(`row_width_mismatch: expected ${fields.length}, got ${vals.length}`);

    const row: Record<string, any> = {};
    const attachmentFields: string[] = [];
    for (let j = 0; j < fields.length; j++) {
      const parsed = parseScalar(vals[j], true);
      if (parsed === MISSING) continue;
      if (parsed === ATTACHMENT) { attachmentFields.push(fields[j]); continue; }
      row[fields[j]] = parsed;
    }
    i++;

    if (rowHasID && attachmentFields.length > 0) {
      const attIndent = ind + '  ';
      const resolved = new Set<string>();
      while (i < lines.length) {
        const al = lines[i];
        if (!al.startsWith(attIndent)) break;
        const ac = al.slice(attIndent.length);
        if (!ac.startsWith('.')) break;
        const [name, val, consumed] = parseAttachment(lines, i, ac.slice(1), depth + 2);
        if (resolved.has(name)) throw new Error(`duplicate_attachment: ${name}`);
        resolved.add(name);
        row[name] = val;
        i += consumed;
      }
      for (const f of attachmentFields) {
        if (!resolved.has(f)) throw new Error(`missing_attachment: ${f}`);
      }
    }

    if (!rowHasID || attachmentFields.length === 0) {
      const attIndent = ind + '  ';
      if (i < lines.length && lines[i].startsWith(attIndent)) {
        const peek = lines[i].slice(attIndent.length);
        if (peek.startsWith('.')) throw new Error(`orphan_attachment: ${peek}`);
      }
    }

    rows.push(row);
    if (expectedCount >= 0 && rows.length >= expectedCount) break;
  }
  return [rows, i - start];
}

function parseAttachment(lines: string[], lineIdx: number, rest: string, depth: number): [string, any, number] {
  let name: string;
  let afterName: string;
  if (rest[0] === '"') {
    let closeIdx = -1;
    for (let j = 1; j < rest.length; j++) {
      if (rest[j] === '\\') { j++; continue; }
      if (rest[j] === '"') { closeIdx = j; break; }
    }
    if (closeIdx < 0) throw new Error('unterminated_quote');
    name = parseQuotedString(rest.slice(0, closeIdx + 1));
    afterName = rest.slice(closeIdx + 1).trimStart();
  } else {
    const sp = rest.indexOf(' ');
    if (sp < 0) throw new Error(`invalid attachment: ${rest}`);
    name = rest.slice(0, sp);
    afterName = rest.slice(sp).trimStart();
  }

  if (afterName.startsWith('{}')) {
    const nested: Record<string, any> = {};
    const consumed = parseObjectBody(lines, lineIdx + 1, depth, nested);
    return [name, nested, consumed + 1];
  }
  if (afterName.startsWith('[')) {
    const [arr, consumed] = parseArrayFromHeader(lines, lineIdx, depth, afterName);
    return [name, arr, consumed];
  }
  throw new Error(`invalid attachment form: ${afterName}`);
}

function parseExpandedBody(lines: string[], start: number, depth: number): [any[], number] {
  const ind = '  '.repeat(depth);
  const items: any[] = [];
  let i = start;

  while (i < lines.length) {
    const line = lines[i];
    const content = depth > 0 ? (line.startsWith(ind) ? line.slice(ind.length) : null) : line;
    if (content === null) break;
    if (content.startsWith('## ') || content.startsWith('##!')) break;
    if (!content.startsWith('@')) break;

    const sp = content.indexOf(' ');
    if (sp < 0) break;

    const idStr = content.slice(1, sp);
    const id = parseInt(idStr, 10);
    if (!isNaN(id) && id !== items.length) {
      throw new Error(`invalid_item_id: expected @${items.length}, got @${idStr}`);
    }

    const marker = content.slice(sp + 1);

    if (marker.startsWith('=')) {
      items.push(parseScalar(marker.slice(1), false));
      i++;
      continue;
    }
    if (marker.startsWith('{}')) {
      const nested: Record<string, any> = {};
      i++;
      const consumed = parseObjectBody(lines, i, depth + 1, nested);
      items.push(nested);
      i += consumed;
      continue;
    }
    if (marker.startsWith('[')) {
      const [arr, consumed] = parseArrayFromHeader(lines, i, depth + 1, marker);
      items.push(arr);
      i += consumed;
      continue;
    }
    break;
  }
  return [items, i - start];
}

function parseCount(s: string): number {
  if (s === '0') return 0;
  if (!s.length || s[0] === '0') throw new Error(`invalid_count: ${s}`);
  const n = parseInt(s, 10);
  if (isNaN(n) || String(n) !== s) throw new Error(`invalid_count: ${s}`);
  return n;
}

function validateSummaryCounts(summaryLine: string, deferredCount: number, contentLines: string[]): void {
  // Parse counts from "##! summary counts=N,M,..."
  const parts = summaryLine.split(/\s+/);
  let countsStr = '';
  for (const p of parts) {
    if (p.startsWith('counts=')) { countsStr = p.slice(7); break; }
  }
  if (!countsStr) return;

  const countVals = countsStr.split(',');
  if (countVals.length !== deferredCount) {
    throw new Error(`count_mismatch: summary has ${countVals.length} count entries but ${deferredCount} deferred sections`);
  }

  // Count actual items per deferred section.
  const actualCounts: number[] = [];
  let inDeferred = false;
  let currentCount = 0;
  for (const l of contentLines) {
    const trimmed = l.trimStart();
    if (trimmed.startsWith('## ') && trimmed.includes('[?]')) {
      if (inDeferred) actualCounts.push(currentCount);
      inDeferred = true;
      currentCount = 0;
      continue;
    }
    if (trimmed.startsWith('## ')) {
      if (inDeferred) { actualCounts.push(currentCount); inDeferred = false; }
      continue;
    }
    if (inDeferred && !trimmed.startsWith(' ') && !trimmed.startsWith('.')) {
      currentCount++;
    }
  }
  if (inDeferred) actualCounts.push(currentCount);

  for (let i = 0; i < countVals.length; i++) {
    const declared = parseInt(countVals[i], 10);
    if (isNaN(declared)) throw new Error(`count_mismatch: invalid count value "${countVals[i]}"`);
    if (i < actualCounts.length && declared !== actualCounts[i]) {
      throw new Error(`count_mismatch: section ${i} declared ${declared} in summary, actual ${actualCounts[i]}`);
    }
  }
}
