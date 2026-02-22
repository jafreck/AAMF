# Manual Prompt for Initial Agent Framework Generation

This repo is going to create an agent framework for migration of extremely large legacy code bases (100k+ lines of code). Huge attention needs to be paid to context window management.

The framework should have a migration runner that laucnhes and manages a migration orchestrator. The orchestrator should checkpoint and be resumeable.

The orchestrator is responsible for coordinating multiple phases: impact assessment and cost estimation, investigation and building a knowledge base, planning the implementation of the migration, migrating the code (which itself is a coordinated loop of writing code, verifying the parity of migration, and writing tests).

After migration is complete, there is a secondary parity checking mechanism to ensure that the final solution is complete, with no remaining gaps, stubs, or behavioral differences.

Following migration, there needs to be a step for crafting end to end tests, documenting the entire migrated codebase.

The orchestrator should not launch subagents, but instad launch a headless, out-of-proc cli invocations ALWAYS of the same model. 

Read-only agents may be parallelized where possible, but serial code writing is acceptable.

Progress needs to be tracked and observable throughout inside (.aamf/migration/{projectName}).

During the phase of building a knowledge base, special attention needs to be paid to large files which should be documented so they can be migrated piecemeal. Then, during the planning stage, those files should be migrated as separate tasks.

When key decisions (like planning) need to be made, an Adjudicator agent should be spawned which will decide between multiple competing plans delivered by investigator agents. Similarly, when migrations hit roadblcoks or fail, this should be tracked in the progress document. Upon failure, there needs to be a process for addressing and fixing the failures. This should include consideration over how to proceed (i.e. a planning stage for fixes), and attempts to reduce the scope of the task should be made.

Context window saturation at every level in the system is critical to minimize.

Create the set of custom copilot agents files required to perform these large scale migrations. There should be at least 12, each of single purpose. In each, there should be defined a set of other agents (unless leafs) that they can launch as subagents.