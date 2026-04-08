# External docs

## Hyperliquid (GitBook export for LLMs)

- **Source**: `https://hyperliquid.gitbook.io/hyperliquid-docs/llms-full.txt`
- **Local copy (generated)**: `docs/external/hyperliquid-docs-llms-full.txt`

### Fetch / update

Run from repo root:

```bash
mkdir -p docs/external
curl -L "https://hyperliquid.gitbook.io/hyperliquid-docs/llms-full.txt" -o "docs/external/hyperliquid-docs-llms-full.txt"
```

### Using in Cursor

- You can reference it directly in chat via: `@docs/external/hyperliquid-docs-llms-full.txt`
- If you use Cursor “Docs” / indexing, add `docs/external/` as a documentation source (then search for “Hyperliquid” inside Docs).

