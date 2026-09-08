## Output Format

Your response must end with a fenced `aamf-json` code block conforming to the Output Schema below. It **must** be the last fenced code block in your output.

Set `outputFiles` to every file created or modified by this invocation. Use absolute paths or paths relative to `config.target.outputPath`; use `[]` when no file was changed.

> ⚠️ Missing or malformed `aamf-json` block (or not the last fenced block) → agent run marked failed.
