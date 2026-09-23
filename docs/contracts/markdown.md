# Markdown and safe rich content

The authored source remains the byte-preserved value in node content or locale strings. `@dungeon-scrivener/markdown` parses it to `SafeBlock[]`; the player never treats authored text as trusted HTML.

## Accepted syntax

- CommonMark paragraphs, headings, emphasis, strong emphasis, block quotes, ordered/unordered lists, fenced/inline code, thematic breaks, and tables.
- Tables use the Markdown table syntax supported by `markdown-it` with its table rule enabled.
- Callouts are block quotes whose first line is one of `> [!NOTE]`, `> [!TIP]`, `> [!IMPORTANT]`, `> [!WARNING]`, or `> [!CAUTION]`. The remaining quoted blocks become the callout body.
- Stable-node links use `[[node:<nodeId>]]` or `[[node:<nodeId>|<label>]]`. The target is an ID, never a display label.
- Node embeds use `![[node:<nodeId>]]`. They insert that node's rendered content in place and remain distinct from navigation links.
- Asset embeds use `![[asset:sha256:<64 lowercase hex digits>|<alt text>]]`. The alt part and separator may be omitted. The asset ID resolves to a local managed file at `assets/sha256/<hex>`.
- Ordinary Markdown links may target absolute `https://` URLs, `mailto:` URLs, or same-document `#fragment` anchors. They are user-activated links and do not load automatically.

## Rejected content

- Raw HTML is disabled and rendered as escaped text. Scriptable SVG/HTML is never inlined as authored markup.
- Standard Markdown image syntax, remote images/media, protocol-relative destinations, `http:`, `javascript:`, `data:`, `file:`, `blob:`, and arbitrary relative paths are rejected with a diagnostic. Use managed asset embeds.
- Unknown node/asset IDs, unsafe destinations, malformed embed syntax, and ambiguous references produce a path and source-span diagnostic. Original Markdown remains unchanged and exportable.
- Heading IDs are generated from source order and text for local fragments. They are not stable node IDs.

Node embed expansion has a maximum depth of 8. A repeated node in the active expansion stack produces a cycle diagnostic and a visible placeholder. Expansion has a maximum of 128 nodes and 2 MiB rendered text per source node; an over-limit document yields a diagnostic and bounded placeholder output.

The safe AST preserves paragraphs, headings, emphasis, strong emphasis, inline code, block quotes, fenced code blocks, thematic breaks, lists, tables, callouts, and node embeds. Table cells contain inline nodes; ordered and unordered list items contain block arrays. Raw HTML is not represented in the AST.

The parser is configured with raw HTML, linkify, typographer, and automatic line-break conversion disabled. Sanitization is a second boundary for generated preview markup. Sanitization never authorizes remote CSS, images, or other resources. Safe AST nodes and asset IDs, rather than HTML strings, cross the player package API.
