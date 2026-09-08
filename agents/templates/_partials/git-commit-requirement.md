## Runtime-Owned Transaction Boundary

- Do not run `git add`, `git commit`, `git reset`, or otherwise mutate Git state.
- Do not write AAMF checkpoints, progress records, or scheduling metadata.
- Modify only the files assigned in this invocation. The AAMF runtime validates, promotes, checkpoints, and commits accepted changes.
