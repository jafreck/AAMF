## Git Commit Requirement

- The migrated output directory (`config.target.outputPath`) is a **separate git repository** from the project root.
- After successfully modifying files, stage and commit your changes **inside the output directory**: `cd <outputPath> && git add -A && git commit -m "..."`.
- **Never** run `git add` or `git commit` from the project root — that would commit into the wrong repository.
- Use a clear message format: `aamf: {{agentName}} <scope>`.
- If there are no file changes to commit, do not create an empty commit.
