import type { DeltaPayload, Symbol, Edge } from './types.js';
import { KIND_ABBREV, KIND_EXPAND } from './constants.js';
import { packRoot } from './packroot.js';

/** Expand a kind abbreviation to its full form; pass through if unknown. */
function expandKind(k: string): string {
  return KIND_EXPAND[k] ?? k;
}

/** Parse a `source -> target type` delta edge line. */
function parseDeltaEdge(line: string): Edge {
  const idx = line.indexOf(' -> ');
  if (idx < 0) {
    throw new Error(`malformed_delta: edge line missing ' -> ': ${JSON.stringify(line)}`);
  }
  const source = line.slice(0, idx);
  const rest = line.slice(idx + 4).trim().split(/\s+/).filter((p) => p.length > 0);
  if (rest.length !== 2) {
    throw new Error(`malformed_delta: edge line ${JSON.stringify(line)} must be 'source -> target type'`);
  }
  return { source, target: rest[0], edgeType: rest[1] };
}

/**
 * EncodeDelta serializes a DeltaPayload into GCF delta format.
 */
export function encodeDelta(d: DeltaPayload): string {
  const lines: string[] = [];

  // Header.
  let savings = 0;
  if (d.fullTokens > 0) {
    savings = Math.round(100 * (1 - d.deltaTokens / d.fullTokens));
  }
  lines.push(
    `GCF profile=graph tool=${d.tool} delta=true base_root=${d.baseRoot} new_root=${d.newRoot} tokens=${d.deltaTokens} savings=${savings}%`
  );

  // Removed symbols: short references (consumer already has the full declaration).
  if (d.removed.length > 0) {
    lines.push('## removed');
    for (const s of d.removed) {
      const kind = KIND_ABBREV[s.kind] || s.kind;
      lines.push(`${kind} ${s.qualifiedName}`);
    }
  }

  // Added symbols: full declarations (consumer doesn't have these).
  if (d.added.length > 0) {
    lines.push('## added');
    for (let i = 0; i < d.added.length; i++) {
      const s = d.added[i];
      const kind = KIND_ABBREV[s.kind] || s.kind;
      lines.push(`@${i} ${kind} ${s.qualifiedName} ${s.score.toFixed(2)} ${s.provenance} ${s.distance}`);
    }
  }

  // Removed edges.
  if (d.removedEdges.length > 0) {
    lines.push('## edges_removed');
    for (const e of d.removedEdges) {
      lines.push(`${e.source} -> ${e.target} ${e.edgeType}`);
    }
  }

  // Added edges.
  if (d.addedEdges.length > 0) {
    lines.push('## edges_added');
    for (const e of d.addedEdges) {
      lines.push(`${e.source} -> ${e.target} ${e.edgeType}`);
    }
  }

  return lines.join('\n') + '\n';
}

/**
 * DecodeDelta parses a GCF graph delta wire payload (as produced by encodeDelta)
 * back into a DeltaPayload. Kind abbreviations on removed/added lines are expanded
 * to their full form so the result matches a base snapshot's symbol identities.
 */
export function decodeDelta(input: string): DeltaPayload {
  const lines = input.replace(/\n+$/, '').split('\n');
  if (lines.length === 0 || lines[0] === '') {
    throw new Error('missing_header: empty delta payload');
  }
  const header = lines[0].replace(/\r+$/, '');
  if (!header.startsWith('GCF profile=graph')) {
    throw new Error("missing_profile: delta header must begin with 'GCF profile=graph'");
  }

  const d: DeltaPayload = {
    tool: '',
    baseRoot: '',
    newRoot: '',
    removed: [],
    added: [],
    removedEdges: [],
    addedEdges: [],
    deltaTokens: 0,
    fullTokens: 0,
  };

  for (const field of header.split(/\s+/)) {
    const eq = field.indexOf('=');
    if (eq < 0) continue;
    const key = field.slice(0, eq);
    const val = field.slice(eq + 1);
    switch (key) {
      case 'tool':
        d.tool = val;
        break;
      case 'base_root':
        d.baseRoot = val;
        break;
      case 'new_root':
        d.newRoot = val;
        break;
    }
  }

  let section = '';
  for (const raw of lines.slice(1)) {
    const line = raw.replace(/\r+$/, '');
    if (line === '') continue;
    if (line.startsWith('## ')) {
      section = line.slice(3).trim();
      switch (section) {
        case 'removed':
        case 'added':
        case 'edges_removed':
        case 'edges_added':
          break;
        default:
          throw new Error(`malformed_delta: unknown section ${JSON.stringify(section)}`);
      }
      continue;
    }
    const parts = line.trim().split(/\s+/).filter((p) => p.length > 0);
    switch (section) {
      case 'removed': {
        if (parts.length !== 2) {
          throw new Error(`malformed_delta: removed line ${JSON.stringify(line)} must be 'kind qname'`);
        }
        d.removed.push({
          kind: expandKind(parts[0]),
          qualifiedName: parts[1],
          score: 0,
          provenance: '',
          distance: 0,
        });
        break;
      }
      case 'added': {
        if (parts.length !== 6) {
          throw new Error(`malformed_delta: added line ${JSON.stringify(line)} must be '@id kind qname score provenance distance'`);
        }
        const score = Number(parts[3]);
        if (!Number.isFinite(score)) {
          throw new Error(`malformed_delta: invalid added score ${JSON.stringify(parts[3])}`);
        }
        const dist = Number(parts[5]);
        if (!Number.isInteger(dist)) {
          throw new Error(`malformed_delta: invalid added distance ${JSON.stringify(parts[5])}`);
        }
        d.added.push({
          kind: expandKind(parts[1]),
          qualifiedName: parts[2],
          score,
          provenance: parts[4],
          distance: dist,
        });
        break;
      }
      case 'edges_removed':
        d.removedEdges.push(parseDeltaEdge(line));
        break;
      case 'edges_added':
        d.addedEdges.push(parseDeltaEdge(line));
        break;
      default:
        throw new Error(`malformed_delta: data line ${JSON.stringify(line)} before any section header`);
    }
  }

  return d;
}

/**
 * Apply a delta to a base set of symbols/edges and verify the resulting pack root.
 *
 * Returns the new symbol and edge sets if the computed root matches expectedNewRoot.
 * Throws if the root does not match.
 */
export function verifyDelta(
  baseSymbols: Symbol[],
  baseEdges: Edge[],
  removedSymbols: Symbol[],
  addedSymbols: Symbol[],
  removedEdges: Edge[],
  addedEdges: Edge[],
  expectedNewRoot: string,
): { symbols: Symbol[]; edges: Edge[] } {
  // Index base symbols by identity (kind, qname).
  const symKey = (kind: string, qname: string) => `${kind}\t${qname}`;
  const symMap = new Map<string, Symbol>();
  for (const s of baseSymbols) {
    symMap.set(symKey(s.kind, s.qualifiedName), s);
  }

  // Apply removals.
  for (const s of removedSymbols) {
    const key = symKey(s.kind, s.qualifiedName);
    if (!symMap.has(key)) {
      throw new Error(`delta_invalid: removing symbol ${s.kind} ${s.qualifiedName} that does not exist in base`);
    }
    symMap.delete(key);
  }

  // Apply additions.
  for (const s of addedSymbols) {
    const key = symKey(s.kind, s.qualifiedName);
    if (symMap.has(key)) {
      throw new Error(`delta_invalid: adding symbol ${s.kind} ${s.qualifiedName} that already exists`);
    }
    symMap.set(key, s);
  }

  const newSymbols = [...symMap.values()];

  // Index base edges by (source, target, edgeType).
  const edgeKey = (e: Edge) => `${e.source}\t${e.target}\t${e.edgeType}`;
  const edgeMap = new Map<string, Edge>();
  for (const e of baseEdges) {
    edgeMap.set(edgeKey(e), e);
  }

  // Apply edge removals.
  for (const e of removedEdges) {
    const key = edgeKey(e);
    if (!edgeMap.has(key)) {
      throw new Error(`delta_invalid: removing edge ${e.source} -> ${e.target} ${e.edgeType} that does not exist`);
    }
    edgeMap.delete(key);
  }

  // Apply edge additions.
  for (const e of addedEdges) {
    const key = edgeKey(e);
    if (edgeMap.has(key)) {
      throw new Error(`delta_invalid: adding edge ${e.source} -> ${e.target} ${e.edgeType} that already exists`);
    }
    edgeMap.set(key, e);
  }

  const newEdges = [...edgeMap.values()];

  // Compute pack root and verify.
  const computed = packRoot(newSymbols, newEdges);
  if (computed !== expectedNewRoot) {
    throw new Error(`root_mismatch: computed ${computed}, expected ${expectedNewRoot}`);
  }

  return { symbols: newSymbols, edges: newEdges };
}
