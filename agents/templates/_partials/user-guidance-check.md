**Check your context JSON for a `guidance` array.** If present, these are user-provided migration directives that you MUST follow. They take precedence over default heuristics.

**If guidance explicitly allows a narrowly-scoped unsafe, ABI, or platform boundary when no safe equivalent exists, treat that as an allowed escape hatch.** Keep it minimal, audited, and isolated behind a safe API.
