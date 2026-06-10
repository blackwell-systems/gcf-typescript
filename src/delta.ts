import type { DeltaPayload } from './types.js';
import { KIND_ABBREV } from './constants.js';

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
      lines.push(`@${i} ${kind} ${s.qualifiedName} ${s.score.toFixed(2)} ${s.provenance}`);
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
