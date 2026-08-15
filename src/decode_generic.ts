import { decode } from './decode.js';
import {
  parseScalar, parseQuotedString, splitRespectingQuotes, splitFieldDecl,
  isBareKey, MISSING, ATTACHMENT, setLargeIntMode, type LargeIntMode,
} from './scalar.js';

// Objects decode into Map, not plain objects, so first-observed key order is
// preserved for every key including integer-like ones ("5", "3"). A plain JS
// object reorders integer-index-like string keys ahead of the rest in numeric
// order (a language quirk), which would corrupt object key order on re-encode.
// The generic encoder is Map-aware (see generic.ts objKeys/objGet), and
// parseJSONOrdered already returns Map, so Map is this SDK's canonical
// order-preserving object representation. Object key ordering is a preserved
// round-trip property (SPEC 52, 931).

// checkDupMap rejects a duplicate key in a decoded object (Map).
function checkDupMap(m: Map<string, any>, key: string): void {
  if (m.has(key)) throw new Error(`duplicate_key: ${key}`);
}

/**
 * Decode GCF generic or graph profile text into a JS value.
 *
 * `opts.largeInt` sets the policy for an in-domain integer whose magnitude exceeds
 * this host's safe-integer range (2^53-1); it defaults to `'error'`. See LargeIntMode.
 */
export function decodeGeneric(input: string, opts?: { largeInt?: LargeIntMode }): any {
  setLargeIntMode(opts?.largeInt ?? 'error');
  try {
    return decodeGenericImpl(input);
  } finally {
    setLargeIntMode('error');
  }
}

function decodeGenericImpl(input: string): any {
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
    if (trimmed.startsWith('## ') && (trimmed.includes('[?]') || trimmed.includes('[?:]'))) deferredSectionCount++;
    contentLines.push(l);
  }

  // Validate ##! summary counts.
  if (summaryLine && deferredSectionCount > 0) {
    validateSummaryCounts(summaryLine, deferredSectionCount, contentLines);
  }

  if (contentLines.length === 0) return new Map<string, any>();

  const first = contentLines[0].trimStart();

  // Root scalar.
  if (first.startsWith('=')) {
    if (contentLines.length > 1) throw new Error('trailing_characters: extra lines after root scalar');
    return parseScalar(first.slice(1), false);
  }

  // Root array.
  if (first.startsWith('## [')) {
    const [arr, consumed] = parseArrayFromHeader(contentLines, 0, 0, first.slice(3));
    // A root array or keyed map spans the whole document, so any structural line
    // past the consumed rows is a surplus item, not sibling content. The row loop
    // stops at the declared count, so the count assert only catches the deficit
    // case; surplus is caught here (SPEC Section 13: a mismatch, fewer OR more
    // items than declared, is an error).
    if (consumed < contentLines.length) {
      throw new Error('count_mismatch: declared count is fewer than the rows present');
    }
    return arr;
  }

  // Root object.
  const result = new Map<string, any>();
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

function parseObjectBody(lines: string[], start: number, depth: number, out: Map<string, any>): number {
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
      const bi = findHeaderBracketStart(hdr);
      if (bi >= 0) {
        const name = parseKeyFromHeader(hdr.slice(0, bi));
        checkDupMap(out, name);
        const [arr, consumed] = parseArrayFromHeader(lines, i, depth, hdr.slice(bi));
        out.set(name, arr);
        i += consumed;
        continue;
      }
      const name = parseKeyFromHeader(hdr);
      checkDupMap(out, name);
      i++;
      const nested = new Map<string, any>();
      const consumed = parseObjectBody(lines, i, depth + 1, nested);
      out.set(name, nested);
      i += consumed;
      continue;
    }

    // Key=value. Check this BEFORE inline array detection so that bracket
    // patterns inside quoted values (e.g. text="ERR[404]: Not Found") are
    // not misinterpreted as inline array headers.
    const eqIdx = findKeyValueSplit(content);
    if (eqIdx > 0) {
      const name = parseKeyFromHeader(content.slice(0, eqIdx));
      checkDupMap(out, name);
      out.set(name, parseScalar(content.slice(eqIdx + 1), false));
      i++;
      continue;
    }

    // Inline array (e.g. items[3]: a,b,c). Only reached if no = found.
    if (!content.startsWith('@') && !content.startsWith('##')) {
      const bracketIdx = arrayBracketStart(content);
      if (bracketIdx > 0) {
        const rest = content.slice(bracketIdx);
        const closeIdx = rest.indexOf(']');
        if (closeIdx >= 0) {
          const after = rest.slice(closeIdx + 1);
          if (after.startsWith(': ') || after === ':') {
            const name = parseKeyFromHeader(content.slice(0, bracketIdx));
            checkDupMap(out, name);
            const [arr] = parseArrayFromHeader(lines, i, depth, rest);
            out.set(name, arr);
            i++;
            continue;
          }
        }
      }
    }

    // An object-body line that is not a `## ` section, a `key=value` field, or
    // an inline array is not valid content and MUST NOT be silently skipped
    // (that dropped data — a lossless round-trip hole). A pipe-delimited line is
    // a stray positional inline body with no eligible `^` cell (SPEC 16.5,
    // orphan_inline_attachment); any other unrecognized line is likewise rejected.
    if (content.includes('|')) {
      throw new Error(`orphan_inline_attachment: ${content}`);
    }
    throw new Error(`invalid_line: unexpected content in object body: ${JSON.stringify(content)}`);
  }
  return i - start;
}

function findKeyValueSplit(s: string): number {
  if (!s.length) return -1;
  // Quoted key: "key"=value
  if (s[0] === '"') {
    for (let i = 1; i < s.length; i++) {
      if (s[i] === '\\') { i++; continue; }
      if (s[i] === '"') return (i + 1 < s.length && s[i + 1] === '=') ? i + 1 : -1;
    }
    return -1;
  }
  // Bare key: find = but only before [ (to avoid matching = inside inline array values)
  const eqIdx = s.indexOf('=');
  if (eqIdx < 0) return -1;
  const bracketIdx = s.indexOf('[');
  if (bracketIdx >= 0 && bracketIdx < eqIdx) return -1;
  return eqIdx;
}

// findHeaderBracketStart locates the " [" that separates a section name from its
// array/keyed count bracket, ignoring any " [" that falls inside a quoted name.
// A section header whose name is a quoted string containing " [" (e.g. `## " [9]"`)
// would otherwise be misread as a named-array header and reject a valid payload.
// Returns the index of the separating space, or -1 for a plain object section.
// Index of the '[' that opens a named-array marker (name[N]:), scanning past a
// quoted key so a '[' inside the key name is not mistaken for the array bracket
// (SPEC 4.2). Bare keys cannot contain '['. Returns -1 when not found.
function arrayBracketStart(content: string): number {
  if (content.charCodeAt(0) === 0x22 /* " */) {
    let escaped = false;
    for (let i = 1; i < content.length; i++) {
      if (escaped) {
        escaped = false;
      } else if (content[i] === '\\') {
        escaped = true;
      } else if (content[i] === '"') {
        return content[i + 1] === '[' ? i + 1 : -1;
      }
    }
    return -1;
  }
  return content.indexOf('[');
}

function findHeaderBracketStart(hdr: string): number {
  let i = 0;
  // Skip a leading quoted key so a " [" inside it is treated as data, not syntax.
  if (hdr[0] === '"') {
    i = 1;
    while (i < hdr.length) {
      if (hdr[i] === '\\') { i += 2; continue; }
      if (hdr[i] === '"') { i++; break; }
      i++;
    }
  }
  const bi = hdr.indexOf(' [', i);
  return bi;
}

function parseKeyFromHeader(s: string): string {
  s = s.trim();
  if (s.length >= 2 && s[0] === '"') return parseQuotedString(s);
  return s;
}

// A path segment that would pollute Object.prototype if it were ever written
// through a plain object. Decoded objects are Maps (Map.set cannot touch the
// prototype chain), but this still filters hostile flatten path segments.
function isUnsafePathKey(k: string): boolean {
  return k === '__proto__' || k === 'constructor' || k === 'prototype';
}

function parseArrayFromHeader(lines: string[], headerLine: number, depth: number, bracketPart: string): [any, number] {
  const bp = bracketPart.trimStart();
  if (!bp.startsWith('[')) throw new Error('invalid_count');
  const closeIdx = bp.indexOf(']');
  if (closeIdx < 0) throw new Error('invalid_count');

  let countStr = bp.slice(1, closeIdx);
  const afterBracket = bp.slice(closeIdx + 1);

  // A `:` suffix on the count marks a keyed map (SPEC 7.2a): the decoder
  // reconstructs a JSON object, not an array. `[N]` without the colon is
  // an ordinary array (Section 7.4).
  const keyed = countStr.endsWith(':');
  if (keyed) {
    countStr = countStr.slice(0, -1);
    if (!afterBracket.startsWith('{')) throw new Error('keyed_map: missing field declaration');
  }

  let count = -1;
  if (countStr !== '?') count = parseCount(countStr);

  // A keyed map has at least one member; an empty object is encoded per
  // Section 7.7, never as [0:] (SPEC 7.2a.4).
  if (keyed && count === 0) {
    throw new Error('keyed_map: zero count [0:] is invalid (an empty object uses Section 7.7)');
  }

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
    if (keyed) return [keyedRowsToMap(rows, fields), consumed + 1];
    return [rows, consumed + 1];
  }

  // Expanded.
  const [items, consumed] = parseExpandedBody(lines, headerLine + 1, depth);
  if (count >= 0 && items.length !== count) throw new Error(`count_mismatch: declared ${count}, got ${items.length}`);
  return [items, consumed + 1];
}

// keyedRowsToMap reconstructs the map from decoded keyed-table rows (SPEC 7.2a.4):
// the first declared field is the member key; the remaining fields form the value
// object. The key-column label is discarded from every value object. Duplicate
// member keys are rejected.
function keyedRowsToMap(rows: Array<Map<string, any>>, fields: string[]): Map<string, any> {
  // A keyed header MUST declare at least two fields: the key column plus at
  // least one value field (SPEC 7.2a.2).
  if (fields.length < 2) throw new Error('keyed_map: header must declare at least two fields');
  const keyLabel = fields[0];
  const out = new Map<string, any>();
  for (const row of rows) {
    // parseTabularBody omits an absent (~) cell; a keyed row always carries the
    // key cell (a scalar per SPEC 7.2a.3), so read it directly.
    const kv = row.has(keyLabel) ? row.get(keyLabel) : undefined;
    const ks = typeof kv === 'string' ? kv : String(kv);
    if (out.has(ks)) throw new Error(`keyed_map: duplicate member key ${ks}`);
    // Strip the key-column label so it is not emitted as a value-object member.
    // The row Map already preserves declared field order, so the value object
    // keeps the value fields in that order (SPEC 7.2a.4).
    const value = new Map<string, any>();
    for (const [f, v] of row) {
      if (f === keyLabel) continue;
      value.set(f, v);
    }
    out.set(ks, value);
  }
  return out;
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

// unflattenPaths reconstructs the nested objects encoded as ">"-path columns.
// It returns a Map keyed by the top-level parent name (in first-observed order),
// so the row assembler can splice each group into the row at the declared
// position of its first path column. Nested leaf order follows path-column order
// (SPEC 7.4.6.1). Objects are Maps so integer-like leaf keys keep their order.
function unflattenPaths(
  pathColumns: Map<string, string[]>,
  flatValues: Map<string, any>,
  flatAbsent: Set<string>,
): Map<string, any> {
  // Group by top-level parent.
  const groups = new Map<string, string[]>();
  const groupOrder: string[] = [];
  for (const [fieldName, paths] of pathColumns) {
    if (paths.length === 0) continue;
    // Drop any path with a prototype-pollution segment. A conformant encoder never
    // emits these; their presence means hand-crafted/hostile GCF, so discard the column.
    if (paths.some(isUnsafePathKey)) continue;
    const top = paths[0];
    if (!groups.has(top)) {
      groups.set(top, []);
      groupOrder.push(top);
    }
    groups.get(top)!.push(fieldName);
  }

  const result = new Map<string, any>();

  for (const top of groupOrder) {
    const fieldNames = groups.get(top)!;
    const allAbsent = fieldNames.every(f => flatAbsent.has(f));
    const allNull = fieldNames.every(f => {
      if (flatAbsent.has(f)) return false;
      const val = flatValues.get(f);
      return val === null;
    });

    if (allAbsent) continue;
    if (allNull) { result.set(top, null); continue; }

    for (const fieldName of fieldNames) {
      if (flatAbsent.has(fieldName)) continue;
      const paths = pathColumns.get(fieldName)!;
      const val = flatValues.has(fieldName) ? flatValues.get(fieldName) : null;

      let current = result;
      for (let k = 0; k < paths.length - 1; k++) {
        const segment = paths[k];
        const existing = current.get(segment);
        // Overwrite with a fresh Map when the slot is missing OR holds a
        // non-Map, so traversal never dereferences a primitive on malformed
        // input. Conformant output never hits this.
        if (!current.has(segment) || !(existing instanceof Map)) {
          current.set(segment, new Map<string, any>());
        }
        current = current.get(segment);
      }
      current.set(paths[paths.length - 1], val);
    }
  }

  return result;
}

function parseTabularBody(lines: string[], start: number, depth: number, fields: string[], expectedCount: number): [any[], number] {
  const ind = '  '.repeat(depth);
  const rows: any[] = [];
  let i = start;

  // Detect path columns: fields containing ">".
  const pathColumnMap = new Map<string, string[]>();
  for (const f of fields) {
    if (f.includes('>')) {
      const parts = f.split('>');
      // Only treat as a path column if all segments are non-empty.
      // A literal key like ">" would split into ["", ""].
      if (parts.every(p => p.length > 0)) {
        pathColumnMap.set(f, parts);
      }
    }
  }

  // Track inline schemas and shared array schemas.
  const inlineSchemas = new Map<string, string[]>();
  const sharedArraySchemas = new Map<string, string[]>();

  while (i < lines.length) {
    const line = lines[i];
    const content = depth > 0 ? (line.startsWith(ind) ? line.slice(ind.length) : null) : line;
    if (content === null) break;
    if (content.startsWith('## ') || content.startsWith('##!')) break;

    if (content.length > 0 && content[0] === ' ') {
      const trimmed = content.trimStart();
      if (trimmed.startsWith('.')) break; // attachment lines handled below (v2 indented or v3)
      break;
    }

    // Strip @N prefix (must be @digits).
    let rowData = content;
    let rowHasID = false;
    if (rowData.startsWith('@')) {
      const sp = rowData.indexOf(' ');
      if (sp > 0) {
        const idStr = rowData.slice(1, sp);
        if (/^\d+$/.test(idStr)) {
          rowData = rowData.slice(sp + 1);
          rowHasID = true;
        }
      }
    }

    const vals = splitRespectingQuotes(rowData, '|');
    if (vals.length !== fields.length) throw new Error(`row_width_mismatch: expected ${fields.length}, got ${vals.length}`);

    // Parse cells: scalars, traditional attachments, and inline schema attachments.
    const cellValues = new Map<string, any>();
    const traditionalAttFields: string[] = [];
    const inlineAttFields: string[] = [];
    const inlineAttOrder: string[] = [];
    const missingFields = new Set<string>();

    // Collect path column values for unflattening.
    const flatValues = new Map<string, any>();
    const flatAbsent = new Set<string>();

    for (let j = 0; j < fields.length; j++) {
      const cellVal = vals[j];

      // Path columns: store values for later unflattening.
      if (pathColumnMap.has(fields[j])) {
        const parsed = parseScalar(cellVal, true);
        if (parsed === MISSING) {
          flatAbsent.add(fields[j]);
        } else {
          flatValues.set(fields[j], parsed);
        }
        continue;
      }

      // Check for ^{fields} inline schema declaration.
      if (cellVal.startsWith('^{') && cellVal.endsWith('}')) {
        const schemaStr = cellVal.slice(1);
        const ifs = splitFieldDecl(schemaStr);
        inlineSchemas.set(fields[j], ifs);
        inlineAttFields.push(fields[j]);
        inlineAttOrder.push(fields[j]);
        continue;
      }

      const parsed = parseScalar(cellVal, true);
      if (parsed === MISSING) { missingFields.add(fields[j]); continue; }
      if (parsed === ATTACHMENT) {
        // Check if this field has a stored inline schema.
        if (inlineSchemas.has(fields[j])) {
          inlineAttFields.push(fields[j]);
          inlineAttOrder.push(fields[j]);
        } else {
          traditionalAttFields.push(fields[j]);
        }
        continue;
      }
      // Handle inline schema objects returned by parseScalar (for ^{...} that got through).
      if (parsed && typeof parsed === 'object' && parsed.__inlineSchema) {
        const ifs = splitFieldDecl(parsed.__inlineSchema);
        inlineSchemas.set(fields[j], ifs);
        inlineAttFields.push(fields[j]);
        inlineAttOrder.push(fields[j]);
        continue;
      }
      cellValues.set(fields[j], parsed);
    }
    i++;

    // Parse attachments in line order.
    const allAttFields = [...traditionalAttFields, ...inlineAttFields];
    const attachmentValues = new Map<string, any>();

    // Expected attachment names = columns of THIS row whose cell was "^" or "^{...}".
    // Any ".fieldname" attachment not in this set (and not a ">"-flatten fallback)
    // is an orphan that no encoder would produce: reject for lossless round-trip.
    const expectedAtt = new Set<string>(allAttFields);

    if (rowHasID) {
      let inlineIdx = 0;

      while (i < lines.length) {
        const aLine = lines[i];
        let aContent: string | null = null;
        if (depth === 0 || aLine.startsWith(ind)) {
          aContent = depth > 0 ? aLine.slice(ind.length) : aLine;
        } else {
          break;
        }
        if (aContent === null) break;

        // Line starts with ".": traditional or prefixed inline attachment.
        // Also handle v2-format indented attachments ("  .field ...").
        let attContent = aContent;
        if (!attContent.startsWith('.') && attContent.startsWith('  .')) {
          attContent = attContent.slice(2); // strip v2 indent
        }
        if (attContent.startsWith('.')) {
          const rest = attContent.slice(1);
          const [attName, afterName] = parseAttachmentName(rest);

          // Reject orphan attachments: a ".fieldname" whose name does not bind to a
          // "^"-marked column and is not a ">"-flatten fallback (SPEC 7.4.6.1.4).
          if (!expectedAtt.has(attName) && !attName.includes('>')) {
            throw new Error(`orphan_attachment: ${attName}`);
          }

          // Check if this is an inline schema field with pipe-delimited data.
          const ifs = inlineSchemas.get(attName);
          if (ifs && !afterName.trimStart().startsWith('{}') && !afterName.trimStart().startsWith('[')) {
            const data = afterName.trimStart();
            const inlineVals = splitRespectingQuotes(data, '|');
            if (inlineVals.length !== ifs.length) throw new Error(`inline_width_mismatch: ${attName} expected ${ifs.length}, got ${inlineVals.length}`);
            const obj = new Map<string, any>();
            for (let k = 0; k < ifs.length; k++) {
              const p = parseScalar(inlineVals[k], true);
              if (p !== MISSING) obj.set(ifs[k], p);
            }
            if (attachmentValues.has(attName)) throw new Error(`duplicate_attachment: ${attName}`);
            attachmentValues.set(attName, obj);
            i++;
            continue;
          }

          // Traditional attachment.
          const [name, val, consumed, parsedFields] = parseAttachment(lines, i, rest, depth + 2, sharedArraySchemas);
          if (attachmentValues.has(name)) throw new Error(`duplicate_attachment: ${name}`);
          // Store shared array schema from first row.
          if (rows.length === 0 && parsedFields) {
            sharedArraySchemas.set(name, parsedFields);
          }
          attachmentValues.set(name, val);
          i += consumed;
          continue;
        }

        // No-prefix line: positional inline data.
        let foundInline = false;
        let nextInlineField = '';
        while (inlineIdx < inlineAttOrder.length) {
          const candidate = inlineAttOrder[inlineIdx];
          if (!attachmentValues.has(candidate)) {
            nextInlineField = candidate;
            foundInline = true;
            break;
          }
          inlineIdx++;
        }
        if (!foundInline) break;

        const ifs = inlineSchemas.get(nextInlineField)!;
        const inlineVals = splitRespectingQuotes(aContent, '|');
        if (inlineVals.length !== ifs.length) throw new Error(`inline_width_mismatch: ${nextInlineField} expected ${ifs.length}, got ${inlineVals.length}`);
        const obj = new Map<string, any>();
        for (let k = 0; k < ifs.length; k++) {
          const p = parseScalar(inlineVals[k], true);
          if (p !== MISSING) obj.set(ifs[k], p);
        }
        attachmentValues.set(nextInlineField, obj);
        inlineIdx++;
        i++;
      }

      for (const f of allAttFields) {
        if (!attachmentValues.has(f)) throw new Error(`missing_attachment: ${f}`);
      }

      // Check for duplicate attachments: if the next line is also an attachment
      // line at this depth, it means there's a second attachment for a field
      // that was already resolved.
      if (i < lines.length) {
        let peekContent: string | null = null;
        if (depth === 0 || lines[i].startsWith(ind)) {
          peekContent = depth > 0 ? lines[i].slice(ind.length) : lines[i];
        }
        if (peekContent !== null) {
          let peekAtt = peekContent;
          if (!peekAtt.startsWith('.') && peekAtt.startsWith('  .')) {
            peekAtt = peekAtt.slice(2);
          }
          if (peekAtt.startsWith('.')) {
            const peekRest = peekAtt.slice(1);
            const [peekName] = parseAttachmentName(peekRest);
            if (attachmentValues.has(peekName)) {
              throw new Error(`duplicate_attachment: ${peekName}`);
            }
          }
        }
      }
    }

    // Reconstruct the row in declared field-union order. A flattened group is
    // emitted at the position of its first path column, so the nested object
    // reappears where the original field was rather than being appended at the
    // end. Nested leaf order follows path-column order. Scalars and attachments
    // stay at their declared position; absent (~) cells are skipped. Object key
    // ordering is a preserved round-trip property (SPEC 7.4.6.1, SPEC 52, 931).
    const nested = pathColumnMap.size > 0
      ? unflattenPaths(pathColumnMap, flatValues, flatAbsent)
      : new Map<string, any>();
    const emittedGroups = new Set<string>();
    const row = new Map<string, any>();
    for (const f of fields) {
      // Path column: emit its top-level group once, at the first path column.
      if (pathColumnMap.has(f)) {
        const top = pathColumnMap.get(f)![0];
        if (emittedGroups.has(top)) continue;
        emittedGroups.add(top);
        // A wholly-absent group is omitted (unflattenPaths drops it).
        if (nested.has(top)) row.set(top, nested.get(top));
        continue;
      }
      if (missingFields.has(f)) continue;
      if (cellValues.has(f)) { row.set(f, cellValues.get(f)); continue; }
      if (attachmentValues.has(f)) { row.set(f, attachmentValues.get(f)); continue; }
    }

    // Also add any orphan attachment values (fields excluded from the column
    // list, e.g. ">" flatten-fallback attachments) after the declared columns.
    for (const [k, v] of attachmentValues) {
      if (!row.has(k)) row.set(k, v);
    }

    rows.push(row);
    if (expectedCount >= 0 && rows.length >= expectedCount) break;
  }
  return [rows, i - start];
}

function parseAttachmentName(rest: string): [string, string] {
  if (rest[0] === '"') {
    for (let j = 1; j < rest.length; j++) {
      if (rest[j] === '\\') { j++; continue; }
      if (rest[j] === '"') {
        const name = parseQuotedString(rest.slice(0, j + 1));
        return [name, rest.slice(j + 1)];
      }
    }
    return ['', rest];
  }
  const sp = rest.indexOf(' ');
  if (sp >= 0) return [rest.slice(0, sp), rest.slice(sp)];
  return [rest, ''];
}

/** Attachment parser: returns [name, value, consumed, parsedFields]. parsedFields is set for tabular arrays with explicit {fields}. */
function parseAttachment(lines: string[], lineIdx: number, rest: string, depth: number, sharedSchemas: Map<string, string[]>): [string, any, number, string[] | null] {
  const [name, afterNameRaw] = parseAttachmentName(rest);
  const afterName = afterNameRaw.trimStart();

  if (afterName.startsWith('{}')) {
    const nested = new Map<string, any>();
    const consumed = parseObjectBody(lines, lineIdx + 1, depth, nested);
    return [name, nested, consumed + 1, null];
  }

  if (afterName.startsWith('[')) {
    const closeBracket = afterName.indexOf(']');
    if (closeBracket < 0) throw new Error('invalid_count: missing ]');
    const afterClose = afterName.slice(closeBracket + 1);

    // [N]{fields} or [N:]{key,fields}: has its own schema.
    if (afterClose.startsWith('{')) {
      // A keyed-map attachment ([N:]) reconstructs an object, not an array, and
      // MUST NOT establish a shared array schema (which is an array-only reuse
      // mechanism, SPEC 7.4.5.3); leave parsedFields null for the keyed form.
      const isKeyed = afterName.slice(1, closeBracket).endsWith(':');
      const endBrace = findClosingBrace(afterClose);
      let parsedFields: string[] | null = null;
      if (!isKeyed && endBrace >= 0) {
        try { parsedFields = splitFieldDecl(afterClose.slice(0, endBrace + 1)); } catch {}
      }
      const [arr, consumed] = parseArrayFromHeader(lines, lineIdx, depth, afterName);
      return [name, arr, consumed, parsedFields];
    }

    // [N]: values or [N] (check for inline primitive array first).
    const afterCloseForInline = afterName.slice(closeBracket + 1);
    if (afterCloseForInline.startsWith(': ') || afterCloseForInline === ':') {
      // Inline primitive array: don't use shared schema.
      const [arr, consumed] = parseArrayFromHeader(lines, lineIdx, depth, afterName);
      return [name, arr, consumed, null];
    }

    // [N] without {fields}: check for shared schema.
    if (sharedSchemas.has(name)) {
      const sf = sharedSchemas.get(name)!;
      const countStr = afterName.slice(1, closeBracket);
      let count = -1;
      if (countStr !== '?') {
        try { count = parseCount(countStr); } catch { count = -1; }
      }
      if (count === 0) return [name, [], 1, null];

      // Peek: if next line starts with @, it's expanded, not tabular.
      const nextIdx = lineIdx + 1;
      const ind = '  '.repeat(depth);
      let useShared = true;
      if (nextIdx < lines.length) {
        let nextContent = lines[nextIdx];
        if (depth > 0 && nextContent.startsWith(ind)) nextContent = nextContent.slice(ind.length);
        if (nextContent.trimStart().startsWith('@')) useShared = false;
      }
      if (useShared) {
        const [rows, consumed] = parseTabularBody(lines, lineIdx + 1, depth, sf, count);
        if (count >= 0 && rows.length !== count) throw new Error(`count_mismatch: declared ${count}, got ${rows.length}`);
        return [name, rows, consumed + 1, null];
      }
    }

    // No shared schema: standard parsing.
    const [arr, consumed] = parseArrayFromHeader(lines, lineIdx, depth, afterName);
    return [name, arr, consumed, null];
  }

  // Scalar: =value (field names containing ">" excluded from tabular columns).
  if (afterName.startsWith('=')) {
    const valStr = afterName.slice(1);
    const parsed = parseScalar(valStr, true);
    if (parsed === MISSING) return [name, null, 1, null];
    return [name, parsed, 1, null];
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
      const nested = new Map<string, any>();
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
    if (trimmed.startsWith('## ') && (trimmed.includes('[?]') || trimmed.includes('[?:]'))) {
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
