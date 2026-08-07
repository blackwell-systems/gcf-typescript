import type { StreamWriter } from './stream.js';
import { formatScalar, formatKey } from './scalar.js';

interface SectionCount {
  name: string;
  count: number;
}

interface ActiveArray {
  name: string;
  fields: string[];
  count: number;
}

/**
 * GenericStreamEncoder writes GCF tabular output incrementally as rows arrive.
 * Zero buffering: each row is written immediately. A trailer summary is
 * emitted on close() with the final counts.
 *
 * @example
 * ```ts
 * const enc = new GenericStreamEncoder({ write: (s) => process.stdout.write(s) });
 * enc.beginArray('employees', ['id', 'name', 'department', 'salary']);
 * enc.writeRow([1, 'Alice', 'Engineering', 95000]);
 * enc.writeRow([2, 'Bob', 'Sales', 72000]);
 * enc.endArray();
 * enc.close();
 * ```
 */
export class GenericStreamEncoder {
  private readonly writer: StreamWriter;
  private sections: SectionCount[] = [];
  private current: ActiveArray | null = null;
  private err: Error | null = null;

  constructor(writer: StreamWriter) {
    this.writer = writer;
    this.writer.write('GCF profile=generic\n');
  }

  /** Start a tabular array section with deferred count [?]. */
  beginArray(name: string, fields: string[]): void {
    if (this.err !== null) {
      return;
    }
    if (this.current !== null) {
      this.endArrayInternal();
    }

    // A streaming tabular row has only flat columns; a field name containing ">"
    // is a flattened path the stream cannot represent (SPEC 8.3, 7.4.6). Record
    // the error and emit no section; it surfaces at close().
    for (const f of fields) {
      if (f.includes('>')) {
        this.err = new Error(
          `streaming field name ${JSON.stringify(f)} contains '>' (a flattened path is not representable in a streaming row)`,
        );
        return;
      }
    }

    this.writer.write(`## ${formatKey(name)} [?]{${formatFieldDecl(fields)}}\n`);
    this.current = { name, fields, count: 0 };
  }

  /** Emit a single pipe-separated row immediately. */
  writeRow(values: unknown[]): void {
    if (this.current === null) {
      return;
    }
    const parts = values.map(formatValue);
    this.writer.write(`${parts.join('|')}\n`);
    this.current.count++;
  }

  /** Close the current array section and record its count. */
  endArray(): void {
    this.endArrayInternal();
  }

  /** Emit a key=value line immediately. */
  writeKV(key: string, value: unknown): void {
    this.writer.write(`${key}=${formatValue(value)}\n`);
  }

  /** Start a nested object section (## key). */
  writeSection(name: string): void {
    if (this.current !== null) {
      this.endArrayInternal();
    }
    this.writer.write(`## ${name}\n`);
  }

  /** Emit a primitive array inline: name[N]: val1,val2,val3 */
  writeInlineArray(name: string, values: unknown[]): void {
    const parts = values.map(formatValue);
    this.writer.write(`${name}[${values.length}]: ${parts.join(',')}\n`);
  }

  /** Emit the ##! summary trailer with final counts. Must be called after all data.
   *  Throws if a rejected field name (containing ">") was passed to beginArray. */
  close(): void {
    if (this.err !== null) {
      throw this.err;
    }
    if (this.current !== null) {
      this.endArrayInternal();
    }
    if (this.sections.length === 0) {
      return;
    }
    const counts = this.sections.map(s => String(s.count));
    this.writer.write(`##! summary counts=${counts.join(',')}\n`);
  }

  private endArrayInternal(): void {
    if (this.current === null) {
      return;
    }
    this.sections.push({ name: this.current.name, count: this.current.count });
    this.current = null;
  }
}

function formatValue(v: unknown): string {
  return formatScalar(v, 0x7c); // '|' context
}

// formatFieldDecl quotes each field name per Section 2.4 (via formatKey), matching
// the buffered tabular header. The streaming header previously joined field names
// raw, so a name containing a delimiter or quote produced an invalid or ambiguous
// header (SPEC 8.3).
function formatFieldDecl(fields: string[]): string {
  return fields.map(formatKey).join(',');
}
