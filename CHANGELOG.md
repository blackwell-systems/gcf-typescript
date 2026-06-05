# Changelog

## v0.1.3 (2026-06-04)

- Docs: update README for npm/PyPI discoverability (gcformat.com, proxy, vs-toon links)

## v0.1.2 (2026-06-04)

- Fix: quote empty strings as `""` in `encodeGeneric` per spec
- Fix: decoder rejects headers missing required `tool` field (conformance)

## v0.1.1 (2026-06-03)

- `encodeGeneric`: encode arbitrary JS values into GCF tabular format
- Tabular encoding: positional rows with pipe separators, section headers, nested field support
- Uniform array detection with 70% key overlap threshold

## v0.1.0 (2026-06-03)

- Initial release
- `encode` / `decode`: full GCF round-trip
- `encodeWithSession`: session deduplication (92.7% savings by 5th call)
- `encodeDelta`: delta encoding for re-queries (81.2% savings)
- `Session` class
- 16 kind abbreviations
- CLI: `gcf encode`, `gcf decode`, `gcf stats`
- ESM module, zero runtime dependencies
