/**
 * GenericDeltaSession: producer-side helper that manages the re-anchor cadence
 * for a stream of generic-profile updates (SPEC Section 10a.8, non-normative
 * producer policy). It is thin sugar over the primitives: each next() emits
 * either a compact delta or, on its chosen cadence, a full re-anchor (the spec's
 * "full" outcome), updating its held base. It introduces NO new wire syntax:
 * every payload it emits is exactly what encodeGenericFull or encodeGenericDelta
 * produce, and the decoder accepts them cadence-agnostically. N and the size
 * guard are the helper's knobs; they are never wire fields.
 *
 * Byte-for-byte interoperable with gcf-go and gcf-python.
 */

import {
  type GenericSet,
  diffGenericSets,
  encodeGenericFull,
  encodeGenericDelta,
} from './generic_delta.js';

/** ReanchorMode selects the session's cadence policy. */
export enum ReanchorMode {
  /** FixedN re-anchors every N turns. */
  FixedN = 0,
  /**
   * SizeGuard re-anchors once the cumulative delta since the last anchor
   * reaches the current full payload's size (size-adaptive).
   */
  SizeGuard = 1,
}

/** DEFAULT_REANCHOR_N is the working default cadence for FixedN (SPEC Section 10a.8). */
export const DEFAULT_REANCHOR_N = 15;

/**
 * ReanchorPolicy selects when a GenericDeltaSession re-anchors. Construct it with
 * fixedN or sizeGuard.
 */
export interface ReanchorPolicy {
  mode: ReanchorMode;
  n: number; // turns between anchors; FixedN only
}

/** fixedN re-anchors every n turns. n <= 0 falls back to DEFAULT_REANCHOR_N. */
export function fixedN(n: number): ReanchorPolicy {
  if (n <= 0) n = DEFAULT_REANCHOR_N;
  return { mode: ReanchorMode.FixedN, n };
}

/**
 * sizeGuard re-anchors once the cumulative delta bytes since the last anchor
 * reach the current full payload's byte size: it re-anchors more under heavy
 * churn, rarely under light churn, and bounds the delta spent between anchors to
 * about one full payload. Production-recommended.
 */
export function sizeGuard(): ReanchorPolicy {
  return { mode: ReanchorMode.SizeGuard, n: 0 };
}

/** UTF-8 byte length, matching Go's len(string). */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

function sameStrings(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** The result of advancing a session by one turn. */
export interface SessionEmission {
  wire: string;
  isFull: boolean;
}

/**
 * GenericDeltaSession holds the current base and re-anchor state for a producer
 * loop. Not safe for concurrent use.
 *
 * Construct with a base, tool, and policy; call currentFull() to get the initial
 * full payload to transmit, then next() for each subsequent state.
 */
export class GenericDeltaSession {
  private base: GenericSet;
  private tool: string;
  private policy: ReanchorPolicy;
  private turnCount = 0;
  private cum = 0; // cumulative delta bytes since the last anchor

  constructor(base: GenericSet, tool: string, policy: ReanchorPolicy) {
    if (policy.mode === ReanchorMode.FixedN && policy.n <= 0) {
      policy = { ...policy, n: DEFAULT_REANCHOR_N };
    }
    this.base = base;
    this.tool = tool;
    this.policy = policy;
  }

  /**
   * currentFull returns the full payload for the current base (encodeGenericFull).
   * Send this first to establish the base; it is also a valid manual re-anchor.
   */
  currentFull(): string {
    return encodeGenericFull(this.base, this.tool);
  }

  /** turn returns the number of next() calls so far (the initial full is turn 0). */
  turn(): number {
    return this.turnCount;
  }

  /**
   * next advances the session by one turn to nextSet, returning the wire to
   * transmit and whether it is a full re-anchor (true) or a delta (false). A
   * schema change forces a full (Section 10a.7). The held base becomes nextSet
   * either way. The wire is byte-identical to calling encodeGenericFull /
   * encodeGenericDelta directly.
   */
  next(nextSet: GenericSet): SessionEmission {
    this.turnCount++;

    // Schema change (or a fresh key) cannot be expressed as a delta -> full.
    if (nextSet.key !== this.base.key || !sameStrings(this.base.fields, nextSet.fields)) {
      return { wire: this.reanchor(nextSet), isFull: true };
    }

    const d = diffGenericSets(this.base, nextSet);
    const deltaWire = encodeGenericDelta(d);

    let reanchor: boolean;
    if (this.policy.mode === ReanchorMode.SizeGuard) {
      reanchor = this.cum + byteLen(deltaWire) >= byteLen(encodeGenericFull(nextSet, this.tool));
    } else {
      reanchor = this.turnCount % this.policy.n === 0;
    }

    if (reanchor) {
      return { wire: this.reanchor(nextSet), isFull: true };
    }
    this.base = nextSet;
    this.cum += byteLen(deltaWire);
    return { wire: deltaWire, isFull: false };
  }

  /**
   * reanchor emits a full payload for nextSet, advances the base, and resets the
   * cumulative-delta counter.
   */
  private reanchor(nextSet: GenericSet): string {
    const wire = encodeGenericFull(nextSet, this.tool);
    this.base = nextSet;
    this.cum = 0;
    return wire;
  }
}
