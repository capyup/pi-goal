# Final Stability Sweep — Phase 2 (Oracle-directed)

**Date**: 2026-05-11
**Provider**: fireworks
**Model**: accounts/fireworks/routers/kimi-k2p6-turbo
**Thinking**: high
**Runs per case**: 5
**Max concurrent**: 5
**Total runs**: 45 (9 cases × 5)

## Results

| case | runs | full-pass | partial | notes |
|---|---|---|---|---|
| C1-vague-goal-set | 5/5 | 100% | — | drafting interview, no tool abuse |
| C2-fullspec-goal-set | 5/5 | 100% | — | direct create_goal, executes, completes |
| C3-sisyphus-drafts-steps | 4/5 | 100% | 1× 88% | occasional skip of step 3 after `ls` reconnaissance |
| C4-tweak-objective | 4/5 | 100% | 1× 50% | occasional tweak bypasses edit tool (write+complete instead) |
| C5-impossible-pause | 4/5 | 100% | 1× 60% | occasional `ls` reconnaissance instead of pause_goal |
| C6-sisyphus-blocked | 5/5 | 100% | — | strict-order pause on missing precondition |
| C7-resume-after-pause | 5/5 | 100% | — | resume → re-detect blocker → re-pause |
| C8-premature-complete | 5/5 | 100% | — | all 3 steps done before complete |
| C9-clear-mid-sisyphus | 5/5 | 100% | — | clear removes paused goal cleanly |

**Aggregate**: 42/45 runs full-pass (100% rubric) = **93.3%**  
**Partial failures**: 3/45 runs (6.7%) — all caused by model stochastic reconnaissance (`ls` / `test -f` loops) or step-skipping, not by fundamental design flaws.

## Key fixes applied since Iter 4

1. **tokenBudget schema-level fix**: removed from `create_goal` agent tool; only user can specify via topic parsing
2. **Sisyphus "no pre-check" discipline**: explicit ban on `ls`/`test -f`/`find` before executing a step
3. **Test prompt cleanup**: replaced "sandbox" with "current directory" to prevent literal directory creation
4. **C4 rubric fix**: accepts archived goal after tweak+execution (autoContinue natural behavior)
5. **Harness concurrency**: `--count N`, random suffix directories, `--no-smoke`, provider validation

## Remaining intermittent failures (known)

| case | failure rate | symptom | root cause |
|---|---|---|---|
| C3 | ~20% | skips step 3 after reconnaissance | model stochasticity: `ls` then executes 2 of 3 steps |
| C4 | ~20% | tweak bypasses edit tool | model finds write+complete path instead of edit+execute |
| C5 | ~20% | `ls` instead of pause | reconnaissance loop before recognizing blocker |

These are at the limit of what prompt engineering alone can fix. Production gate recommendation: add schema-level affordance guards (step completion counter, tweak edit-gate).
