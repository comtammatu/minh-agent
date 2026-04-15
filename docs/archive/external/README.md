# External docs

> Archive note (2026-04-15): vendor/reference snapshots kept for offline lookup. These files are not the source of truth for current repo architecture.

## Hyperliquid (GitBook export for LLMs)

- **Source**: `https://hyperliquid.gitbook.io/hyperliquid-docs/llms-full.txt`
- **Local copy (generated)**: `docs/archive/external/hyperliquid-docs-llms-full.txt`

### Fetch / update

Run from repo root:

```bash
mkdir -p docs/archive/external
curl -L "https://hyperliquid.gitbook.io/hyperliquid-docs/llms-full.txt" -o "docs/archive/external/hyperliquid-docs-llms-full.txt"
```

### Using in Cursor

- You can reference it directly in chat via: `@docs/archive/external/hyperliquid-docs-llms-full.txt`
- If you use Cursor “Docs” / indexing, add `docs/archive/external/` as a documentation source (then search for “Hyperliquid” inside Docs).
