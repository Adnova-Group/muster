TASK: implement-auth (wave 1)
ROLE: implement
OWNS: src/auth/**
FROZEN: src/payments/**, docs/**

Add JWT auth middleware to the Express API. The wave also dispatches a docs task
concurrently -- your OWNS/FROZEN fences above are what keep the two writers from
colliding on the shared working tree.

## Return contract
Return raw data, <=2000 chars: files changed (as paths), test counts, deviations
one line each. No code snippets, stack traces, or file dumps.
