<p align="center">
  <a href="https://github.com/blackwell-systems"><img src="https://raw.githubusercontent.com/blackwell-systems/blackwell-docs-theme/main/badge-trademark.svg" alt="Blackwell Systems"></a>
  <a href="https://github.com/blackwell-systems/gcf-typescript/actions"><img src="https://github.com/blackwell-systems/gcf-typescript/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License"></a>
</p>

# gcf-typescript

TypeScript implementation of [GCF (Graph Compact Format)](https://github.com/blackwell-systems/gcf).

**84% fewer tokens than JSON. 32% fewer than TOON. 100% LLM comprehension accuracy at 500 symbols, where JSON fails.**

## Install

```
npm install @blackwell-systems/gcf
```

Zero dependencies. TypeScript-first. Includes CLI.

## CLI

```bash
npx @blackwell-systems/gcf encode < payload.json    # JSON to GCF
npx @blackwell-systems/gcf decode < payload.gcf     # GCF to JSON
npx @blackwell-systems/gcf stats  < payload.json    # token comparison
```

```
Payload: 50 symbols, 20 edges

  JSON  ██████████████████████████████  4,200 tokens
  GCF   ████████░░░░░░░░░░░░░░░░░░░░░░  1,150 tokens

  Savings: 73% fewer tokens with GCF
```

Or install globally: `npm install -g @blackwell-systems/gcf` then use `gcf` directly.

## Library

### Quick Start

```typescript
import { encode, type Payload } from '@blackwell-systems/gcf';

const p: Payload = {
  tool: 'context_for_task',
  tokenBudget: 5000,
  tokensUsed: 1847,
  symbols: [
    { qualifiedName: 'pkg.AuthMiddleware', kind: 'function', score: 0.78, provenance: 'lsp_resolved', distance: 0 },
    { qualifiedName: 'pkg.NewServer', kind: 'function', score: 0.54, provenance: 'lsp_resolved', distance: 1 },
  ],
  edges: [
    { source: 'pkg.NewServer', target: 'pkg.AuthMiddleware', edgeType: 'calls' },
  ],
};

const output = encode(p);
```

Output:
```
GCF tool=context_for_task budget=5000 tokens=1847 symbols=2
## targets
@0 fn pkg.AuthMiddleware 0.78 lsp_resolved
## related
@1 fn pkg.NewServer 0.54 lsp_resolved
## edges
@0<@1 calls
```

## Decode

```typescript
import { decode } from '@blackwell-systems/gcf';

const p = decode(input);
console.log(p.tool, p.symbols.length, 'symbols', p.edges.length, 'edges');
```

## Session Deduplication

Track transmitted symbols across multiple tool responses. Previously-sent symbols become bare references instead of full declarations:

```typescript
import { Session, encodeWithSession } from '@blackwell-systems/gcf';

const sess = new Session();

const out1 = encodeWithSession(payload1, sess); // full declarations
const out2 = encodeWithSession(payload2, sess); // reused symbols as "@N  # previously transmitted"
```

By the 5th call in a session: 92.7% token savings vs JSON.

## Delta Encoding

When the consumer already has a prior context pack, send only what changed:

```typescript
import { encodeDelta, type DeltaPayload } from '@blackwell-systems/gcf';

const delta: DeltaPayload = {
  tool: 'context_for_task',
  baseRoot: 'aaa111',
  newRoot: 'bbb222',
  removed: [{ qualifiedName: 'pkg.OldFunc', kind: 'function', score: 0, provenance: '', distance: 0 }],
  added: [{ qualifiedName: 'pkg.NewFunc', kind: 'function', score: 0.85, provenance: 'rwr', distance: 0 }],
  removedEdges: [],
  addedEdges: [],
  deltaTokens: 30,
  fullTokens: 200,
};

const output = encodeDelta(delta);
```

81.2% savings on re-queries where the pack changed slightly.

## Generic Encoding

Encode any JS value (not just graph payloads) into GCF tabular format:

```typescript
import { encodeGeneric } from '@blackwell-systems/gcf';

const output = encodeGeneric({
  employees: [
    { id: 1, name: 'Alice', department: 'Engineering', salary: 95000 },
    { id: 2, name: 'Bob', department: 'Sales', salary: 72000 },
  ],
});
```

Output:
```
## employees [2]{id,name,department,salary}
1|Alice|Engineering|95000
2|Bob|Sales|72000
```

Works on objects, arrays, and primitives. Arrays of uniform objects get tabular rows. Nested objects use `## key` section headers.

## API

| Function | Description |
|----------|-------------|
| `encode(p: Payload): string` | Encode a graph payload to GCF text |
| `encodeGeneric(data: unknown): string` | Encode any value to GCF tabular format |
| `decode(input: string): Payload` | Parse GCF text back to a Payload |
| `encodeWithSession(p: Payload, s: Session): string` | Encode with session deduplication |
| `encodeDelta(d: DeltaPayload): string` | Encode a delta (added/removed only) |
| `new Session()` | Create a new session tracker |

## Types

| Type | Purpose |
|------|---------|
| `Payload` | Full GCF payload: tool, budget, symbols, edges, pack root |
| `Symbol` | Graph node: qualified name, kind, score, provenance, distance |
| `Edge` | Directed relationship: source, target, edge type |
| `DeltaPayload` | Diff between two packs: added/removed symbols and edges |
| `Session` | Tracker for multi-call deduplication |
| `KIND_ABBREV` / `KIND_EXPAND` | Bidirectional kind abbreviation maps |

## Comprehension Eval

A rigorous 3-way benchmark (GCF vs TOON vs JSON) at 500 symbols, 200 edges. Six structured extraction questions sent to an LLM:

| Format | Accuracy | Tokens | vs JSON |
|--------|----------|--------|---------|
| **GCF** | **100%** (6/6) | **11,090** | **79% fewer** |
| TOON | 100% (6/6) | 16,378 | 69% fewer |
| JSON | 66.7% (4/6) | 53,341 | baseline |

JSON failed on counting tasks. GCF and TOON both achieved perfect accuracy. GCF does it in 32% fewer tokens.

## Token Efficiency (TOON's Own Benchmark)

Running [TOON's benchmark harness](https://github.com/blackwell-systems/toon/tree/gcf-comparison) with GCF inserted (their datasets, their tokenizer):

| Track | GCF | TOON | Result |
|-------|-----|------|--------|
| Mixed-structure (nested, semi-uniform) | 169,554 | 227,896 | **GCF 34% smaller** |
| Flat-only (tabular) | 66,026 | 67,837 | **GCF 3% smaller** |
| Semi-uniform event logs | 107,269 | 154,032 | **GCF 44% smaller** |

GCF wins on every dataset except deeply nested config (75 tokens on a 618-token payload). On semi-uniform data, GCF uses 44% fewer tokens than TOON.

Reproducible: [blackwell-systems/toon@gcf-comparison](https://github.com/blackwell-systems/toon/tree/gcf-comparison)

## Related

- [Specification](https://github.com/blackwell-systems/gcf) (grammar, encoding rules, design constraints)
- [gcf-go](https://github.com/blackwell-systems/gcf-go) (Go implementation)
- [TOON benchmark fork](https://github.com/blackwell-systems/toon/tree/gcf-comparison) (reproducible token counts)

## License

MIT
