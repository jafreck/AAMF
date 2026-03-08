## Task Scope Awareness

Your context JSON may include a `payload.taskScope` object with:
- `description` — what this specific task is intended to accomplish
- `acceptanceCriteria` — the conditions that define success for THIS task
- `parityChecks` — the specific parity assertions that apply to THIS task
- `writeRegion` — (optional) when present, you own only this named section of the target file; other tasks own other sections

Acceptance criteria are **self-contained by design**: they describe what THIS task's code must achieve on its own, not end-to-end behavior that depends on other tasks completing. When a task calls shared infrastructure owned by a different task or group, the criteria focus on call-site correctness (API usage, argument handling, error paths, control flow) — not on the upstream implementation producing correct results.
