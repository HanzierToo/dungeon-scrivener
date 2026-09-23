# DungeonScrivener

DungeonScrivener is a local-first text-adventure authoring environment and player. This repository is the master repository. Product and implementation scope is defined in `DungeonScrivener-1.0-Plan.md` and `DungeonScrivener-Agent-Prompts/00-MASTER.md`. The accepted v1 data/API contracts are under `docs/contracts/`.

## Development commands

Requires Node.js 24.19.0 (or Node.js 22.12 or newer, below 25) and npm 10 or newer. `.nvmrc` pins the current development runtime; `packageManager` pins npm.

```sh
npm ci
npm run check:contracts
npm run typecheck
npm test
```

The Vitest suite is intentionally empty at the 1B contract-freeze boundary. Playwright is configured for Chromium, Firefox, and WebKit. To run browser tests after adding them:

```sh
npx playwright install chromium firefox webkit
npm run test:e2e
```

No application runtime or editor features are implemented in task 1B.
