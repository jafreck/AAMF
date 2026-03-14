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

Notes:

- Root `npm install` also installs `runtime/` dependencies through the repo `postinstall` script.
- Root `npm run build` delegates to `runtime/` and builds the AAMF CLI.

## Run AAMF

The CLI lives in `runtime/`, so run it from there:

```bash
cd runtime
npx aamf migrate -c ../migration.config.json
```

Common variants:

```bash
cd runtime
npx aamf migrate -c ../migration.config.json --dry-run
npx aamf migrate -c ../migration.config.json --resume
npx aamf migrate -c ../migration.config.json --phase 4
npx aamf status -c ../migration.config.json
npx aamf reset -c ../migration.config.json
```

## Test the runtime

From the repository root:

```bash
nvm use
npm test
```

Or directly in `runtime/`:

```bash
cd runtime
npm test
```

## Troubleshooting

- If native modules fail after switching Node versions, rerun `npm install` from the repo root while on Node 22.
- If `npx aamf` is not found, make sure `runtime/` has been built with `npm run build`.
- If agent invocations fail immediately, verify the selected CLI (`copilot` or `claude`) is installed and available on `PATH`.