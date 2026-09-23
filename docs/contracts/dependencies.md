# 1B dependency pins

The root lockfile records exact direct versions. No CDN or runtime network lookup is part of the product. Libraries below are local build/runtime dependencies for future owning packages; 1B does not implement their behavior.

| Package | Version | Use | License |
| --- | ---: | --- | --- |
| `react` | `19.3.0` | Authoring UI component runtime | MIT |
| `react-dom` | `19.3.0` | Browser renderer for the authoring UI | MIT |
| `@types/react` | `19.3.0` | React type declarations | MIT |
| `@types/react-dom` | `19.3.0` | React DOM type declarations | MIT |
| `@xyflow/react` | `12.11.6` | Apprentice visual graph editor | MIT |
| `codemirror` | `6.0.2` | Sage text editor base configuration | MIT |
| `@codemirror/language` | `6.12.4` | CodeMirror language support API, including Lua stream mode | MIT |
| `@codemirror/lang-javascript` | `6.2.5` | JavaScript source highlighting/editor support | MIT |
| `@codemirror/lang-python` | `6.2.1` | Python source highlighting/editor support | MIT |
| `@codemirror/lang-json` | `6.0.2` | Structured JSON document editing | MIT |
| `@codemirror/lang-markdown` | `6.5.2` | Markdown source editing | MIT |
| `@codemirror/legacy-modes` | `6.5.4` | Lua highlighting through `StreamLanguage.define` | MIT |
| `typescript` | `7.0.2` | Strict type checking | Apache-2.0 |
| `vite` | `8.3.0` | Build-tool peer for Vitest and future authoring app | MIT |
| `vitest` | `5.0.1` | Focused module test runner | MIT |
| `@playwright/test` | `1.63.0` | Chromium, Firefox, and WebKit test runner | Apache-2.0 |
| `ajv` | `8.20.0` | Draft 2020-12 schema/example validation | MIT |
| `ajv-formats` | `3.0.1` | RFC 3339 `date-time` validation in schemas | MIT |
| `fflate` | `0.8.3` | Browser/Node ZIP codec for later VFS/save packages | MIT with the upstream SheetJS licensing exception described by its notice |
| `markdown-it` | `15.0.2` | CommonMark-oriented Markdown tokenization | MIT |
| `dompurify` | `3.4.15` | HTML sanitization for the editor preview boundary | MPL-2.0 OR Apache-2.0 |
| `acorn` | `8.18.0` | JavaScript subset parser | MIT |
| `luaparse` | `0.3.1` | Lua subset parser | MIT |
| `@types/luaparse` | `0.2.13` | Lua parser declarations | MIT |
| `@lezer/python` | `1.1.19` | Python grammar parser | MIT |
| `@types/node` | `24.13.6` | Node 24 config/tooling types | MIT |

Sources checked 2026-09-23: [React](https://www.npmjs.com/package/react), [React DOM](https://www.npmjs.com/package/react-dom), [React Flow](https://www.npmjs.com/package/%40xyflow/react), [CodeMirror base](https://www.npmjs.com/package/codemirror), [CodeMirror language support](https://www.npmjs.com/package/%40codemirror/language), [CodeMirror JavaScript](https://www.npmjs.com/package/%40codemirror/lang-javascript), [CodeMirror Python](https://www.npmjs.com/package/%40codemirror/lang-python), [CodeMirror JSON](https://www.npmjs.com/package/%40codemirror/lang-json), [CodeMirror Markdown](https://www.npmjs.com/package/%40codemirror/lang-markdown), [CodeMirror legacy modes](https://www.npmjs.com/package/%40codemirror/legacy-modes), [React types](https://www.npmjs.com/package/%40types/react), [React DOM types](https://www.npmjs.com/package/%40types/react-dom), [TypeScript releases](https://github.com/microsoft/TypeScript/releases), [Vite on npm](https://www.npmjs.com/package/vite), [Vitest on npm](https://www.npmjs.com/package/vitest), [Vitest 5 requirements](https://vitest.dev/guide/migration/), [Playwright Test on npm](https://www.npmjs.com/package/%40playwright/test), [Ajv on npm](https://www.npmjs.com/package/ajv), [ajv-formats on npm](https://www.npmjs.com/package/ajv-formats), [fflate on npm](https://www.npmjs.com/package/fflate), [markdown-it on npm](https://www.npmjs.com/package/markdown-it), [DOMPurify on npm](https://www.npmjs.com/package/dompurify), [Acorn on npm](https://www.npmjs.com/package/acorn), [luaparse on npm](https://www.npmjs.com/package/luaparse), [Lezer Python on npm](https://www.npmjs.com/package/%40lezer/python), [Node types on npm](https://www.npmjs.com/package/%40types/node).

TypeScript 7.0.2 is the current stable release at this freeze. Its compiler is a native rewrite; this repository uses only the `tsc` type-check command and does not depend on the compiler API. Re-evaluate compatibility before adding compiler API consumers.

Vitest 5 requires Node.js 22.12 or newer and Vite 6.4 or newer. The root pins Node 24.19.0 through `.nvmrc`, accepts Node `>=22.12.0 <25`, and pins npm 11.17.0 through `packageManager`.

`luaparse` is a small MIT parser with a last-publish date older than the other selected tools. The frozen Lua grammar below is intentionally a small Lua 5.3-compatible subset. The parser only creates syntax trees; it never executes source. Recheck its maintenance and security posture when task 17A starts. It may be replaced only through the contract change procedure if the chosen AST can still report source spans and reject unsupported constructs.
