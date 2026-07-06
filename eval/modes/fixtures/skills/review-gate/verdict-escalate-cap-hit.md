VERDICT: ESCALATE

- BLOCKER: the retry fix still leaves a race condition under concurrent writers (third fix iteration, cap hit -- escalating to the human).
- RISK: the fix narrows the race window but does not close it.
