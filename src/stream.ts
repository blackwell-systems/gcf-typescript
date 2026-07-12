import { KIND_ABBREV } from './constants.js';
import type { Symbol, Edge } from './types.js';

/**
 * Options for the streaming encoder.
 */
export interface StreamOptions {
  tokenBudget?: number;
  tokensUsed?: number;
  packRoot?: string;
  session?: boolean;
  /**
   * Opt into the labeled trailer counts form (SPEC §8.4.1): the graph
   * "##! summary" counts field is emitted as label:count per entry
   * (e.g. counts=targets:1,related:1,edges:1). Default/undefined emits the
   * positional form (counts=1,1,1), unchanged and byte-identical to today.
   */
  labeledTrailerCounts?: boolean;
}

/**
 * A writable sink for streaming output. Accepts string chunks.
 * Compatible with Node.js streams, web WritableStreams, or simple callbacks.
 */
export interface StreamWriter {
  write(chunk: string): void;
}

/**
 * StreamEncoder writes GCF output incrementally as symbols and edges arrive.
 * Zero buffering: each symbol/edge is written immediately. A trailer summary
 * is emitted on close() with the final counts.
 *
 * @example
 * ```ts
 * const chunks: string[] = [];
 * const enc = new StreamEncoder({ write: (s) => chunks.push(s) }, 'context_for_task', { tokenBudget: 5000 });
 * enc.writeSymbol({ qualifiedName: 'pkg.Auth', kind: 'function', score: 0.95, provenance: 'lsp', distance: 0 });
 * enc.writeEdge({ source: 'pkg.Server', target: 'pkg.Auth', edgeType: 'calls' });
 * enc.close();
 * ```
 */
export class StreamEncoder {
  private w: StreamWriter;
  private symIndex: Map<string, number> = new Map();
  private nextID = 0;
  private currentGroup = '';
  private groupCounts: Map<string, number> = new Map();
  private edgeCount = 0;
  private edgesStarted = false;
  private labeledTrailerCounts = false;

  constructor(w: StreamWriter, tool: string, opts: StreamOptions = {}) {
    this.w = w;
    this.labeledTrailerCounts = opts.labeledTrailerCounts ?? false;
    this.writeHeader(tool, opts);
  }

  private writeHeader(tool: string, opts: StreamOptions): void {
    const parts = [`GCF profile=graph tool=${tool}`];
    if (opts.tokenBudget) parts.push(`budget=${opts.tokenBudget}`);
    if (opts.tokensUsed) parts.push(`tokens=${opts.tokensUsed}`);
    if (opts.packRoot) parts.push(`pack_root=${opts.packRoot}`);
    if (opts.session) parts.push('session=true');
    this.w.write(parts.join(' ') + '\n');
  }

  /**
   * Emit a symbol line immediately. Group headers are emitted automatically
   * when the distance changes.
   */
  writeSymbol(s: Symbol): void {
    const groupNames = ['targets', 'related', 'extended'];
    const groupName = s.distance < groupNames.length
      ? groupNames[s.distance]
      : `distance_${s.distance}`;

    if (groupName !== this.currentGroup) {
      this.w.write(`## ${groupName}\n`);
      this.currentGroup = groupName;
    }

    const id = this.nextID++;
    this.symIndex.set(s.qualifiedName, id);

    const kind = KIND_ABBREV[s.kind] || s.kind;
    this.w.write(`@${id} ${kind} ${s.qualifiedName} ${s.score.toFixed(2)} ${s.provenance}\n`);

    this.groupCounts.set(groupName, (this.groupCounts.get(groupName) || 0) + 1);
  }

  /**
   * Emit an edge line immediately. The edges section header is emitted
   * automatically on the first edge (with [?] deferred count).
   * Source and target must reference previously-written symbols.
   */
  writeEdge(e: Edge): void {
    const srcIdx = this.symIndex.get(e.source);
    const tgtIdx = this.symIndex.get(e.target);
    if (srcIdx === undefined || tgtIdx === undefined) return;

    if (!this.edgesStarted) {
      this.w.write('## edges [?]\n');
      this.edgesStarted = true;
    }

    let line = `@${tgtIdx}<@${srcIdx} ${e.edgeType}`;
    if (e.status && e.status !== 'unchanged') {
      line += ` ${e.status}`;
    }
    this.w.write(line + '\n');
    this.edgeCount++;
  }

  /**
   * Emit a bare reference for a previously-transmitted symbol (session mode).
   */
  writeBareRef(qname: string, distance: number): void {
    const groupNames = ['targets', 'related', 'extended'];
    const groupName = distance < groupNames.length
      ? groupNames[distance]
      : `distance_${distance}`;

    if (groupName !== this.currentGroup) {
      this.w.write(`## ${groupName}\n`);
      this.currentGroup = groupName;
    }

    const id = this.nextID++;
    this.symIndex.set(qname, id);
    this.w.write(`@${id}  # previously transmitted\n`);

    this.groupCounts.set(groupName, (this.groupCounts.get(groupName) || 0) + 1);
  }

  /**
   * Emit the ##! summary trailer with final counts. Must be called after all
   * symbols and edges have been written.
   */
  close(): void {
    // Build sections as label:count pairs; positional form strips to values.
    const sections: string[] = [];
    const groupOrder = ['targets', 'related', 'extended'];

    for (const g of groupOrder) {
      const c = this.groupCounts.get(g);
      if (c && c > 0) sections.push(`${g}:${c}`);
    }
    for (const [g, c] of this.groupCounts) {
      if (!groupOrder.includes(g) && c > 0) sections.push(`${g}:${c}`);
    }
    if (this.edgeCount > 0) {
      sections.push(`edges:${this.edgeCount}`);
    }

    const countsStr = this.labeledTrailerCounts
      ? sections.join(',')
      : sections.map((s) => s.split(':', 2)[1]).join(',');

    this.w.write(`##! summary symbols=${this.nextID} edges=${this.edgeCount} counts=${countsStr}\n`);
  }

  /** Number of symbols written so far. */
  get symbolCount(): number { return this.nextID; }

  /** Number of edges written so far. */
  get edgeCount_(): number { return this.edgeCount; }
}
