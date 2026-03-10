## Task Scope Awareness

Your context JSON may include a `payload.taskScope` object with:
- `description` — what this specific task is intended to accomplish
- `acceptanceCriteria` — the conditions that define success for THIS task
- `parityChecks` — the specific parity assertions that apply to THIS task
- `symbols` — the specific symbols (functions, types, constants) assigned to this task, each with `name`, `kind`, `file`, `startLine`, `endLine`
- `lineRange` — the source line range this task covers

### Shared Target Files

Multiple tasks may write to the **same target file** (e.g., when a large source file is split into several tasks by symbol range). When `taskScope.symbols` is present:
- **Only add or modify code for the symbols listed in your task.** Do not rewrite, reorder, or remove code outside your symbol set.
- If the target file already contains code from a previous task, **append your symbols** (or replace only the stubs matching your symbols) — leave all other content untouched.
- Do not reorganize imports, module-level attributes, or other file-wide constructs beyond what is necessary for your symbols to compile.
- If you need to add a shared import or declaration, add it — do not remove existing ones.
