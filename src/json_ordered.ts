/**
 * Order-preserving JSON parser.
 *
 * JavaScript's built-in JSON.parse returns plain objects, and plain objects
 * reorder integer-index-like string keys ("0", "5", ...) ahead of other keys
 * in numeric order (a language quirk). GCF's generic profile requires
 * first-observed insertion order for object keys (SPEC 7.4.3), so a value like
 * {"key":..,"5":..,"#x":..} must keep that textual order. This parser returns a
 * Map for every JSON object, which preserves insertion order for all keys, so
 * the generic encoder produces the same canonical wire as the other SDKs (which
 * parse into ordered maps: gcf-go ParseJSONOrdered, gcf-python's dict).
 *
 * Arrays become plain arrays; scalars become the usual JS primitives (numbers as
 * number, matching JSON.parse). This is a strict JSON parser: it accepts exactly
 * the JSON grammar and throws on malformed input.
 */

/** Parse a JSON string, returning Map for objects (insertion order preserved). */
export function parseJSONOrdered(text: string): unknown {
  const p = new Parser(text);
  p.skipWs();
  const v = p.parseValue();
  p.skipWs();
  if (p.pos !== p.text.length) {
    throw new SyntaxError(`Unexpected token in JSON at position ${p.pos}`);
  }
  return v;
}

class Parser {
  text: string;
  pos: number;

  constructor(text: string) {
    this.text = text;
    this.pos = 0;
  }

  skipWs(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  parseValue(): unknown {
    if (this.pos >= this.text.length) throw new SyntaxError('Unexpected end of JSON input');
    const c = this.text[this.pos];
    switch (c) {
      case '{': return this.parseObject();
      case '[': return this.parseArray();
      case '"': return this.parseString();
      case 't': return this.parseLiteral('true', true);
      case 'f': return this.parseLiteral('false', false);
      case 'n': return this.parseLiteral('null', null);
      default: return this.parseNumber();
    }
  }

  parseObject(): Map<string, unknown> {
    const m = new Map<string, unknown>();
    this.pos++; // consume '{'
    this.skipWs();
    if (this.text[this.pos] === '}') { this.pos++; return m; }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') {
        throw new SyntaxError(`Expected string key in JSON at position ${this.pos}`);
      }
      const key = this.parseString();
      this.skipWs();
      if (this.text[this.pos] !== ':') {
        throw new SyntaxError(`Expected ':' in JSON at position ${this.pos}`);
      }
      this.pos++; // consume ':'
      this.skipWs();
      const val = this.parseValue();
      // Last writer wins, but keep the first-observed position (matches JSON.parse
      // and the ordered-map SDKs, where a repeated key updates in place).
      m.set(key, val);
      this.skipWs();
      const ch = this.text[this.pos];
      if (ch === ',') { this.pos++; continue; }
      if (ch === '}') { this.pos++; return m; }
      throw new SyntaxError(`Expected ',' or '}' in JSON at position ${this.pos}`);
    }
  }

  parseArray(): unknown[] {
    const arr: unknown[] = [];
    this.pos++; // consume '['
    this.skipWs();
    if (this.text[this.pos] === ']') { this.pos++; return arr; }
    for (;;) {
      this.skipWs();
      arr.push(this.parseValue());
      this.skipWs();
      const ch = this.text[this.pos];
      if (ch === ',') { this.pos++; continue; }
      if (ch === ']') { this.pos++; return arr; }
      throw new SyntaxError(`Expected ',' or ']' in JSON at position ${this.pos}`);
    }
  }

  parseString(): string {
    const start = this.pos;
    this.pos++; // consume opening quote
    let out = '';
    let plainStart = this.pos;
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x22) { // closing quote
        out += this.text.slice(plainStart, this.pos);
        this.pos++;
        return out;
      }
      if (c === 0x5c) { // backslash escape
        out += this.text.slice(plainStart, this.pos);
        this.pos++;
        const e = this.text[this.pos];
        switch (e) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            const hex = this.text.slice(this.pos + 1, this.pos + 5);
            if (hex.length !== 4 || !/^[0-9a-fA-F]{4}$/.test(hex)) {
              throw new SyntaxError(`Invalid unicode escape in JSON at position ${this.pos}`);
            }
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            throw new SyntaxError(`Invalid escape in JSON at position ${this.pos}`);
        }
        this.pos++;
        plainStart = this.pos;
        continue;
      }
      if (c < 0x20) {
        throw new SyntaxError(`Unescaped control character in JSON at position ${this.pos}`);
      }
      this.pos++;
    }
    throw new SyntaxError(`Unterminated string in JSON at position ${start}`);
  }

  parseNumber(): number | bigint {
    const start = this.pos;
    const re = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
    re.lastIndex = this.pos;
    const m = re.exec(this.text);
    if (!m || m.index !== this.pos || m[0].length === 0) {
      throw new SyntaxError(`Unexpected token in JSON at position ${start}`);
    }
    this.pos += m[0].length;
    const tok = m[0];
    // Token shape follows the numeric domain (SPEC 2.3.2): a bare-integer literal (no
    // fraction, no exponent) is an int64-domain integer. This bridge ingests JSON for
    // encoding, so it preserves such a value exactly: as a number within the safe range
    // and as a bigint beyond it (rather than floating it through Number), and rejects a
    // value outside int64. A decimal or exponent literal is a double.
    if (!tok.includes('.') && !tok.includes('e') && !tok.includes('E')) {
      const b = BigInt(tok);
      if (b < -9223372036854775808n || b > 9223372036854775807n) {
        throw new Error(`out_of_range: integer ${tok} is outside the canonical int64 domain [-9223372036854775808, 9223372036854775807]; model larger values as strings (SPEC 2.3.2)`);
      }
      return b >= -9007199254740991n && b <= 9007199254740991n ? Number(b) : b;
    }
    return Number(tok);
  }

  parseLiteral<T>(word: string, value: T): T {
    if (this.text.slice(this.pos, this.pos + word.length) !== word) {
      throw new SyntaxError(`Unexpected token in JSON at position ${this.pos}`);
    }
    this.pos += word.length;
    return value;
  }
}
