/**
 * Common scalar grammar for GCF.
 * Shared between encoder, decoder, and streaming encoder.
 */

const JSON_NUMBER_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
const NUMERIC_LIKE_RE = /^[+-]\.?\d|^\.\d|^0\d/;
const INLINE_ARRAY_RE = /\[[^\]]*\]\s*:/;

// Numeric domain (SPEC 2.3.2). The canonical integer domain is signed int64. In this
// SDK the native number is a binary64, exact only to 2^53-1, so an in-domain integer
// whose magnitude exceeds 2^53-1 (the [2^53, 2^63-1] and [-2^63, -2^53] sub-ranges)
// cannot be held as a `number` without loss and is governed by a documented policy.
const I64_MIN = -9223372036854775808n; // -2^63
const I64_MAX = 9223372036854775807n; //  2^63-1
const MAX_SAFE = 9007199254740991n; //  2^53-1

/**
 * Policy for an in-domain integer whose magnitude exceeds 2^53-1 (a value the host
 * `number` cannot hold exactly). This is a JavaScript-local boundary, not the numeric
 * domain edge (which is int64 and is enforced regardless of this policy). SPEC 2.3.2.
 * - `'error'` (default): throw rather than return a value that would later lose
 *   precision in `number` arithmetic.
 * - `'string'`: return the decimal digits as a string (recommended for identifiers).
 * - `'bigint'`: return a native `bigint` (lossless, for consumers that compute on it).
 * - `'number'`: return a `number` (explicit, lossy).
 */
export type LargeIntMode = 'error' | 'string' | 'bigint' | 'number';

// Decode-wide policy for the current decode. Set by the decode entry points before
// parsing and reset afterwards; read by parseScalar. Decode is synchronous and
// non-reentrant, so a module-scoped value is safe and avoids threading the mode
// through every internal decode helper.
let currentLargeInt: LargeIntMode = 'error';

/** Set the large-integer policy for the current decode (see LargeIntMode). */
export function setLargeIntMode(mode: LargeIntMode): void {
  currentLargeInt = mode;
}

/** Build the actionable out-of-range message for a value outside the int64 domain. */
function outOfRangeMessage(value: string): string {
  return `out_of_range: integer ${value} is outside the canonical int64 domain [-9223372036854775808, 9223372036854775807]; model larger values as strings (SPEC 2.3.2)`;
}

/** Build the message for an in-domain value the host `number` cannot hold exactly. */
function unsafeIntegerMessage(value: string): string {
  return `unsafe_integer: integer ${value} exceeds the safe-integer range (2^53-1) of a JavaScript number; decode with largeInt 'string' | 'bigint' | 'number', or model the value as a string (SPEC 2.3.2)`;
}

/** Check if a string value must be quoted per Section 2.4. */
export function needsQuote(s: string): boolean {
  if (s === '') return true;
  if (s === '-' || s === '~' || s === '^' || s === 'true' || s === 'false') return true;
  // A string shaped like an inline-schema attachment marker (^{...}) would decode
  // as an attachment, not a string, in a tabular cell; quote it (SPEC 2.4). The
  // decoder recognizes exactly `^{` ... `}`, so match that set.
  if (s.length >= 3 && s[0] === '^' && s[1] === '{' && s[s.length - 1] === '}') return true;
  if (JSON_NUMBER_RE.test(s)) return true;
  if (NUMERIC_LIKE_RE.test(s)) return true;
  if (s[0] === ' ' || s[s.length - 1] === ' ') return true;
  if (s[0] === '#' || s[0] === '@' || s[0] === '.') return true;
  if (INLINE_ARRAY_RE.test(s)) return true;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 0x22 || c === 0x5c || c < 0x20 || c === 0x0a || c === 0x0d ||
        c === 0x7c || c === 0x2c) return true; // " \ control \n \r | ,
    // C1 control characters
    if (c >= 0x80 && c <= 0x9f) return true;
    // Unicode whitespace beyond ASCII
    if (c > 0x7f && (c === 0xa0 || c === 0x2028 || c === 0x2029 || c === 0xfeff ||
        c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x202f ||
        c === 0x205f || c === 0x3000)) return true;
  }
  return false;
}

/** Produce a JSON-compatible quoted string. */
export function quoteString(s: string): string {
  let out = '"';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    switch (c) {
      case 0x22: out += '\\"'; break;
      case 0x5c: out += '\\\\'; break;
      case 0x08: out += '\\b'; break;
      case 0x0c: out += '\\f'; break;
      case 0x0a: out += '\\n'; break;
      case 0x0d: out += '\\r'; break;
      case 0x09: out += '\\t'; break;
      default:
        if (c < 0x20) {
          out += '\\u' + c.toString(16).padStart(4, '0');
        } else {
          out += s[i];
        }
    }
  }
  return out + '"';
}

/** Format a JS value as a GCF scalar. delimiter is '|', ',', or 0. */
export function formatScalar(v: unknown, delimiter: number = 0): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return formatNumber(v);
  // A bigint is the exact-integer type: serialize its exact digits across the whole
  // closed int64 interval (including -2^63), and reject a bigint outside int64 with an
  // out-of-range error rather than emitting a bare token the decoder rejects (SPEC 2.3.2).
  if (typeof v === 'bigint') {
    if (v < I64_MIN || v > I64_MAX) throw new Error(outOfRangeMessage(v.toString()));
    return v.toString();
  }
  const s = String(v);
  if (needsQuote(s) || (delimiter && s.includes(String.fromCharCode(delimiter)))) {
    return quoteString(s);
  }
  return s;
}

/** Format a number per Section 2.3 canonical rules. */
export function formatNumber(f: number): string {
  // Negative zero canonicalizes to 0 (SPEC 2.3.1): -0 equals 0 by value.
  if (f === 0) return '0';
  const abs = Math.abs(f);
  // Plain decimal only below 2^53. Every double at or above 2^53 is integer-valued,
  // so a plain rendering would emit a bare-integer token: indistinguishable from an
  // int64 on the wire and beyond this host's safe-integer range (2^53-1), so a
  // JavaScript decoder rejects it under its default policy. Exponent shape keeps bare
  // tokens int64 and decimal/exponent tokens doubles (SPEC 2.3.1). 2^53 = 9007199254740992.
  if (abs >= 1e-6 && abs < 9007199254740992) {
    return toPreciseDecimal(f);
  }
  // Exponent notation.
  let s = f.toExponential();
  // Normalize: lowercase e, no leading zeros in exponent.
  s = s.replace(/[eE]\+?0*(\d)/, 'e+$1').replace(/[eE]-0*(\d)/, 'e-$1');
  return s;
}

function toPreciseDecimal(f: number): string {
  // String(f) produces the shortest representation that round-trips through parseFloat.
  return String(f);
}

/**
 * Format a graph score to exactly two decimals with round-half-to-even applied to
 * the exact IEEE-754 double (SPEC 5). This matches the C/Go printf family, Python,
 * Rust, and .NET. It deliberately does NOT use Number.prototype.toFixed, which
 * rounds half-up and diverges at exact binary midpoints (0.125 -> 0.12 not 0.13,
 * 0.625 -> 0.62 not 0.63), producing a non-interoperable wire.
 */
export function formatScore(x: number): string {
  if (!Number.isFinite(x)) return '0.00';
  const neg = x < 0;
  const a = Math.abs(x);
  // Exact decimal expansion of the double, far enough to decide 2-decimal rounding.
  const exp = a.toFixed(20);
  const dot = exp.indexOf('.');
  const intPart = exp.slice(0, dot);
  const frac = exp.slice(dot + 1);
  const keep = frac.slice(0, 2).padEnd(2, '0');
  const rest = frac.slice(2);
  const firstRest = rest.charCodeAt(0) - 48;
  let roundUp: boolean;
  if (firstRest > 5) roundUp = true;
  else if (firstRest < 5) roundUp = false;
  else if (/[1-9]/.test(rest.slice(1))) roundUp = true; // strictly greater than .5
  else roundUp = ((keep.charCodeAt(1) - 48) % 2) === 1; // exact tie -> round to even
  let cents = parseInt(intPart, 10) * 100 + parseInt(keep, 10);
  if (roundUp) cents += 1;
  const whole = Math.floor(cents / 100);
  const frac2 = (cents % 100).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac2}`;
}

const BARE_KEY_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

/** Check if a key is a valid bare key. */
export function isBareKey(s: string): boolean {
  return BARE_KEY_RE.test(s);
}

/** Format a key, quoting if necessary. */
export function formatKey(s: string): string {
  return isBareKey(s) ? s : quoteString(s);
}

// --- Decoder scalar parsing ---

/** Parse a GCF scalar token per Section 2.1 precedence. */
export function parseScalar(s: string, tabularContext: boolean): any {
  if (s === '') return '';

  // 1. Quoted string.
  if (s[0] === '"') return parseQuotedString(s);

  // 2. Null.
  if (s === '-') return null;

  // 3. Missing (tabular only).
  if (s === '~') {
    if (!tabularContext) throw new Error('invalid_missing: ~ outside tabular row cell');
    return MISSING;
  }

  // 4. Attachment (tabular only). Plain ^ or ^{fields} (inline schema).
  if (s === '^' || (s.startsWith('^{') && s.endsWith('}'))) {
    if (!tabularContext) throw new Error('invalid_attachment_marker: ^ outside tabular row cell');
    if (s === '^') return ATTACHMENT;
    // Inline schema: return the schema string for the caller to parse.
    return { __inlineSchema: s.slice(1) }; // e.g. "{name,email,tier}"
  }

  // 5. Boolean.
  if (s === 'true') return true;
  if (s === 'false') return false;

  // 6. Number. Token shape follows the numeric domain (SPEC 2.3.2): a bare-integer
  // literal (no fraction, no exponent) is an int64-domain integer; a decimal or
  // exponent literal is a double.
  if (JSON_NUMBER_RE.test(s)) {
    if (!s.includes('.') && !s.includes('e') && !s.includes('E')) {
      const b = BigInt(s); // exact; `-0` parses to 0n
      if (b < I64_MIN || b > I64_MAX) throw new Error(outOfRangeMessage(s));
      // Within the safe-integer range: a plain number is exact and idiomatic.
      if (b >= -MAX_SAFE && b <= MAX_SAFE) return Number(b);
      // In-domain but beyond 2^53-1: the host number cannot hold it exactly, so apply
      // the documented large-integer policy (SPEC 2.3.2).
      switch (currentLargeInt) {
        case 'string': return s;
        case 'bigint': return b;
        case 'number': return Number(b);
        case 'error':
        default:
          throw new Error(unsafeIntegerMessage(s));
      }
    }
    const f = Number(s);
    if (!isNaN(f)) return f;
  }

  // 7. Bare string.
  return s;
}

export const MISSING = Symbol('missing');
export const ATTACHMENT = Symbol('attachment');

/** Parse a JSON-compatible quoted string. */
export function parseQuotedString(s: string): string {
  if (s.length < 2 || s[0] !== '"') throw new Error('unterminated_quote');
  let out = '';
  let i = 1;
  while (i < s.length) {
    if (s[i] === '"') {
      if (i + 1 !== s.length) throw new Error('trailing_characters: after closing quote');
      return out;
    }
    if (s[i] === '\\') {
      if (i + 1 >= s.length) throw new Error('unterminated_quote');
      i++;
      switch (s[i]) {
        case '"': out += '"'; break;
        case '\\': out += '\\'; break;
        case '/': out += '/'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case 'n': out += '\n'; break;
        case 'r': out += '\r'; break;
        case 't': out += '\t'; break;
        case 'u': {
          if (i + 4 >= s.length) throw new Error('invalid_escape: incomplete unicode');
          const hex = s.slice(i + 1, i + 5);
          const code = parseInt(hex, 16);
          if (isNaN(code)) throw new Error(`invalid_escape: invalid unicode \\u${hex}`);
          // Surrogate pair handling.
          if (code >= 0xd800 && code <= 0xdbff) {
            if (i + 10 >= s.length || s[i + 5] !== '\\' || s[i + 6] !== 'u') {
              throw new Error('invalid_surrogate: isolated high surrogate');
            }
            const hex2 = s.slice(i + 7, i + 11);
            const low = parseInt(hex2, 16);
            if (isNaN(low) || low < 0xdc00 || low > 0xdfff) {
              throw new Error('invalid_surrogate: invalid low surrogate');
            }
            out += String.fromCodePoint(0x10000 + (code - 0xd800) * 0x400 + (low - 0xdc00));
            i += 11;
            continue;
          }
          if (code >= 0xdc00 && code <= 0xdfff) {
            throw new Error('invalid_surrogate: isolated low surrogate');
          }
          out += String.fromCharCode(code);
          i += 5;
          continue;
        }
        default: throw new Error(`invalid_escape: unknown \\${s[i]}`);
      }
      i++;
      continue;
    }
    if (s.charCodeAt(i) < 0x20) {
      throw new Error(`invalid_escape: unescaped control U+${s.charCodeAt(i).toString(16).padStart(4, '0')}`);
    }
    out += s[i];
    i++;
  }
  throw new Error('unterminated_quote');
}

/** Split a string on a delimiter, respecting quoted strings. */
export function splitRespectingQuotes(s: string, delim: string): string[] {
  const parts: string[] = [];
  let current = '';
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) { current += s[i]; escaped = false; continue; }
    if (s[i] === '\\' && inQuote) { current += s[i]; escaped = true; continue; }
    if (s[i] === '"') { inQuote = !inQuote; current += s[i]; continue; }
    if (s[i] === delim && !inQuote) { parts.push(current); current = ''; continue; }
    current += s[i];
  }
  parts.push(current);
  return parts;
}

/** Split a field declaration like {id,"display name","a,b"}. */
export function splitFieldDecl(s: string): string[] {
  if (s.length < 2 || s[0] !== '{') throw new Error('invalid field declaration');
  const closeIdx = findClosingBrace(s);
  if (closeIdx < 0) throw new Error('invalid field declaration');
  const inner = s.slice(1, closeIdx);
  if (!inner) return [];
  const raw = splitRespectingQuotes(inner, ',');
  const fields: string[] = [];
  const seen = new Set<string>();
  for (const f of raw) {
    const trimmed = f.trim();
    let name: string;
    if (trimmed.length >= 2 && trimmed[0] === '"' && trimmed[trimmed.length - 1] === '"') {
      name = parseQuotedString(trimmed);
    } else {
      if (!isBareKey(trimmed)) throw new Error(`invalid field name: ${trimmed}`);
      name = trimmed;
    }
    if (seen.has(name)) throw new Error(`duplicate_field_name: ${name}`);
    seen.add(name);
    fields.push(name);
  }
  return fields;
}

function findClosingBrace(s: string): number {
  let inQuote = false;
  let escaped = false;
  for (let i = 0; i < s.length; i++) {
    if (escaped) { escaped = false; continue; }
    if (s[i] === '\\' && inQuote) { escaped = true; continue; }
    if (s[i] === '"') { inQuote = !inQuote; continue; }
    if (s[i] === '}' && !inQuote) return i;
  }
  return -1;
}
