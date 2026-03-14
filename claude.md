# AAMF Run Instructions

Use Node.js 22 for this repository. The pinned version is defined in `.nvmrc`, so start every shell in the repo with:

```bash
nvm use
```

If Node 22 is not installed yet, run:

```bash
nvm install
nvm use
```

## Prerequisites

- Node.js 22 via `nvm use`
- An installed agent CLI:
  - Copilot CLI for `agentRuntime: "copilot"`
  - Claude Code CLI for `agentRuntime: "claude-code"`
- A valid `migration.config.json`

## Install and build

From the repository root:

```bash
nvm use
npm install
npm run build
```

## Run AAMF

From the repository root:

```bash
npx aamf migrate -c migration.config.json
```

Common variants:

```bash
npx aamf migrate -c migration.config.json --dry-run
npx aamf migrate -c migration.config.json --resume
npx aamf migrate -c migration.config.json --phase 4
npx aamf status -c migration.config.json
npx aamf reset -c migration.config.json
```

## Test

From the repository root:

```bash
nvm use
npm test
```

## Troubleshooting

- If native modules fail after switching Node versions, rerun `npm install` from the repo root while on Node 22.
- If `npx aamf` is not found, make sure the project has been built with `npm run build`.
- If agent invocations fail immediately, verify the selected CLI (`copilot` or `claude`) is installed and available on `PATH`.