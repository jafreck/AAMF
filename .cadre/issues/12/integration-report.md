# Integration Report: Issue #12

## Install

**Command:** `cd runtime && npm install`
**Exit Code:** 0
**Status:** pass

## Build

**Command:** `cd runtime && npm run build`
**Exit Code:** 0
**Status:** pass

## Test

**Command:** `cd runtime && npm test`
**Exit Code:** 0
**Status:** pass

## Pre-existing Failures

_None_

## New Regressions

_None_

```cadre-json
{"buildResult":{"command":"cd runtime && npm run build","exitCode":0,"signal":null,"output":"\n> aamf-runtime@0.1.0 build\n> tsc\n\n","pass":true},"testResult":{"command":"cd runtime && npm test","exitCode":0,"signal":null,"output":"\n> aamf-runtime@0.1.0 test\n> vitest run\n\n\n RUN  v2.1.9 /Users/jacobfreck/.cadre/aamf/worktrees/issue-12/runtime\n\n ✓ tests/agents/types.test.ts (19 tests) 4ms\n ✓ tests/result-parser.test.ts (44 tests) 13ms\n ↓ tests/e2e-lz4-rust.test.ts (28 tests | 28 skipped)\n ↓ tests/e2e-protobuf-upb-rust.test.ts (27 tests | 27 skipped)\n ↓ tests/e2e-zstd-rust.test.ts (28 tests | 28 skipped)\n ↓ tests/e2e-jq-csharp.test.ts (31 tests | 31 skipped)\n ↓ tests/e2e-sqlite-csharp.test.ts (28 tests | 28 skipped)\nstdout | ","pass":true},"overallPass":true,"regressionFailures":[],"baselineFailures":[]}
```
