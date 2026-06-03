import type { Payload, Symbol } from './types.js';
import { KIND_ABBREV } from './constants.js';

interface DistanceGroup {
  distance: number;
  symbols: Symbol[];
}

function groupByDistance(symbols: Symbol[]): DistanceGroup[] {
  if (symbols.length === 0) return [];

  const groups: DistanceGroup[] = [];
  let current: DistanceGroup | null = null;

  for (const s of symbols) {
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

  // Header line.
  let header = `GCF tool=${p.tool} budget=${p.tokenBudget} tokens=${p.tokensUsed} symbols=${p.symbols.length}`;
  if (p.packRoot) {
    header += ` pack_root=${p.packRoot}`;
  }
  lines.push(header);

  // Build symbol index for edge references.
  const symIndex = new Map<string, number>();
  for (let i = 0; i < p.symbols.length; i++) {
    symIndex.set(p.symbols[i].qualifiedName, i);
  }

  // Group symbols by distance.
  const groups = groupByDistance(p.symbols);
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

  // Edges section.
  if (p.edges.length > 0) {
    const edgeLines: string[] = [];
    for (const e of p.edges) {
      const srcIdx = symIndex.get(e.source);
      const tgtIdx = symIndex.get(e.target);
      if (srcIdx === undefined || tgtIdx === undefined) continue;

      let line = `@${tgtIdx}<@${srcIdx} ${e.edgeType}`;
      if (e.status && e.status !== 'unchanged') {
        line += ` ${e.status}`;
      }
      edgeLines.push(line);
    }
    if (edgeLines.length > 0) {
      lines.push('## edges');
      lines.push(...edgeLines);
    }
  }

  return lines.join('\n') + '\n';
}
