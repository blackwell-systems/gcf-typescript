import type { Payload, Symbol } from './types.js';
import { KIND_ABBREV } from './constants.js';

interface DistanceGroup {
  distance: number;
  symbols: Symbol[];
}

function groupByDistance(symbols: Symbol[]): DistanceGroup[] {
  if (symbols.length === 0) return [];

  // Sort by distance ascending, then score descending.
  const sorted = [...symbols].sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    return b.score - a.score;
  });

  const groups: DistanceGroup[] = [];
  let current: DistanceGroup | null = null;

  for (const s of sorted) {
    if (current === null || current.distance !== s.distance) {
      current = { distance: s.distance, symbols: [] };
      groups.push(current);
    }
    current.symbols.push(s);
  }

  return groups;
}

/**
 * Encode serializes a Payload into GCF text format.
 */
export function encode(p: Payload): string {
  const lines: string[] = [];

  // Group and sort first, then build index in output order.
  const groups = groupByDistance(p.symbols);
  const symIndex = new Map<string, number>();
  let nextID = 0;
  for (const g of groups) {
    for (const s of g.symbols) {
      symIndex.set(s.qualifiedName, nextID++);
    }
  }

  // Count valid edges (both endpoints in symbol index).
  const validEdges = p.edges.filter(
    (e) => symIndex.has(e.source) && symIndex.has(e.target)
  ).length;

  // Header line.
  let header = `GCF profile=graph tool=${p.tool}`;
  if (p.tokenBudget) header += ` budget=${p.tokenBudget}`;
  if (p.tokensUsed) header += ` tokens=${p.tokensUsed}`;
  header += ` symbols=${p.symbols.length}`;
  if (validEdges > 0) header += ` edges=${validEdges}`;
  if (p.packRoot) {
    header += ` pack_root=${p.packRoot}`;
  }
  lines.push(header);

  const groupNames = ['targets', 'related', 'extended'];

  for (const g of groups) {
    if (g.symbols.length === 0) continue;

    let name: string;
    if (g.distance < groupNames.length) {
      name = groupNames[g.distance];
    } else {
      name = `distance_${g.distance}`;
    }
    lines.push(`## ${name}`);

    for (const s of g.symbols) {
      const idx = symIndex.get(s.qualifiedName)!;
      const kind = KIND_ABBREV[s.kind] || s.kind;
      lines.push(`@${idx} ${kind} ${s.qualifiedName} ${s.score.toFixed(2)} ${s.provenance}`);
    }
  }

  // Edges section. Order edges by source ID then target ID (then edge type for
  // parallel edges) so the wire is canonical regardless of the order edges were
  // provided (SPEC 16.1). Edge reordering is decode-invariant (edges are a set)
  // and does not affect pack_root, which sorts edge records independently.
  if (p.edges.length > 0) {
    interface ResolvedEdge {
      srcIdx: number;
      tgtIdx: number;
      edgeType: string;
      status?: string;
    }
    const resolved: ResolvedEdge[] = [];
    for (const e of p.edges) {
      const srcIdx = symIndex.get(e.source);
      const tgtIdx = symIndex.get(e.target);
      if (srcIdx === undefined || tgtIdx === undefined) continue;
      resolved.push({ srcIdx, tgtIdx, edgeType: e.edgeType, status: e.status });
    }
    // Stable sort (Array.prototype.sort is stable in modern Node).
    resolved.sort((a, b) => {
      if (a.srcIdx !== b.srcIdx) return a.srcIdx - b.srcIdx;
      if (a.tgtIdx !== b.tgtIdx) return a.tgtIdx - b.tgtIdx;
      return a.edgeType < b.edgeType ? -1 : a.edgeType > b.edgeType ? 1 : 0;
    });

    lines.push(`## edges [${validEdges}]`);
    for (const e of resolved) {
      let line = `@${e.tgtIdx}<@${e.srcIdx} ${e.edgeType}`;
      if (e.status && e.status !== 'unchanged') {
        line += ` ${e.status}`;
      }
      lines.push(line);
    }
  }

  return lines.join('\n') + '\n';
}
