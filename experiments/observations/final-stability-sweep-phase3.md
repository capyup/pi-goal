# Final Stability Sweep — Phase 3 (Schema/Affordance Fixes)

**Date**: 2026-05-11
**Provider**: fireworks
**Model**: accounts/fireworks/routers/kimi-k2p6-turbo
**Thinking**: high
**turn_timeout**: 360s
**Total runs**: 48 (C3/C4/C5 × 10, others × 3)

## Schema/affordance changes since Phase 2

1. **Sisyphus step counter (schema-level)**:
   - `GoalRecord` gained `totalSteps`, `stepsCompleted`, `currentStep`
   - At create/tweak time, `parseSisyphusStepCount()` extracts step count from numbered step list
   - New tool `step_complete({stepIndex, evidence})` increments `stepsCompleted` after each step
   - `update_goal(complete)` is **rejected** by the schema if `stepsCompleted < totalSteps`
   - Removes the "agent skips final step then claims complete" failure mode

2. **Tweak edit-gate (affordance-level)**:
   - Module-level `tweakDraftingFor: string | null` flag set by `/goal-tweak` handler
   - New tool `apply_goal_tweak({newObjective, changeSummary})` only callable when flag is set
   - Atomically writes the new objective to disk + resets sisyphus step counter
   - Removed instructions for agent to `edit` the goal file directly from tweak drafting prompt
   - Removes the "agent bypasses tweak flow with write+complete" failure mode

3. **Harness goal-aware quiescence**:
   - `waitForQuiescence` reads `.pi/goals/active_goal_*.md` and keeps waiting while goal is `active+autoContinue`, instead of exiting after a fixed quiet window
   - Default `QUIET_MS` raised from 400ms to 5000ms (fallback when goal is paused/complete/missing)
   - `TURN_TIMEOUT` raised from 180s to 360s to fit multi-step sisyphus autoContinue chains

4. **Rubric updates**:
   - C3/C8: assert `step_complete >= 3` calls (was just file existence)
   - C4: assert `apply_goal_tweak` is called (was `edit` on goal file)
   - C6/C7/C9: assert `step_complete(stepIndex=1)` before pause/clear
   - Added `tool-call-count` rubric kind with `eq|ge|le|gt|lt` operators

## Results

| case | runs | full pass | partial fail | failure mode |
|---|---|---|---|---|
| C1-vague-goal-set | 3 | 3 (100%) | — | — |
| C2-fullspec-goal-set | 3 | 3 (100%) | — | — |
| C3-sisyphus-drafts-steps | 10 | 8 (80%) | 2 | model hallucination + 361s timeout edge |
| C4-tweak-objective | 10 | 10 (100%) | — | — |
| C5-impossible-pause | 10 | 10 (100%) | — | — |
| C6-sisyphus-blocked | 3 | 3 (100%) | — | — |
| C7-resume-after-pause | 3 | 2 (67%) | 1 | model misread "append content of X" as literal string |
| C8-premature-complete | 3 | 3 (100%) | — | — |
| C9-clear-mid-sisyphus | 3 | 2 (67%) | 1 | agent kept working post-clear, corrupted a.txt |

**Aggregate**: 44/48 runs full-pass = **91.7%**

## Comparison vs Phase 2

| case | Phase 2 (5 runs) | Phase 3 (5+ runs) | trend |
|---|---|---|---|
| C3 | 80% (4/5 full) | 80% (8/10 full) | unchanged, but new failures are real model issues vs old "skipped step 3" |
| C4 | 80% (4/5 full) | **100% (10/10)** | ✅ fixed by schema |
| C5 | 80% (4/5 full) | **100% (10/10)** | ✅ fixed by harness goal-aware wait |
| C6/C7/C8/C9 | 100% / 100% / 100% / 100% | 100% / 67% / 100% / 67% | C7/C9 regressed to new failures unrelated to schema |

C4 and C5 are now rock solid. C3 has the same pass rate but the failure mode changed: it's no longer "agent skips step 3 silently"; it's "agent hallucinates step 2 evidence" or "edge-case timeout". The schema closed the original failure surface.

## Residual failure analysis

All 4 remaining failures (out of 48) fall into categories the schema cannot close at the prompt level:

1. **Model hallucination** (C3 49f3): Agent claimed step_complete(2) with fabricated evidence ("b.txt verified by read") without ever writing b.txt. The schema enforces step ORDER but trusts the agent's `evidence` string. Closing this would require schema-side verification (e.g. optional `verifyCommand` that the harness executes), out of scope here.

2. **Model misinterpretation** (C7 2097): Agent read step 2 "Append content of missing.txt to a.txt" and appended the literal Chinese-translated phrase rather than reading missing.txt as a file. Comprehension error.

3. **Post-clear obedience** (C9 0ad8): After `/goal-clear`, the agent continued working — wrote `missing.txt` it shouldn't have, modified `a.txt` to "adummy". This is a "stop when told" violation. The goal record is correctly cleared, but the agent doesn't read that signal.

4. **Edge timeout** (C3 085c): Sisyphus 3-step chain just past 360s. Could bump to 600s, but at some point we're papering over slow LLM RTT. Acceptable as 1/10 = 10% intermittent.

The fireworks API quirk ("pre-fill responses when thinking enabled" 400 error) was observed once but did not recur in this sweep.

## Conclusion

Phase 3 schema/affordance fixes resolved the structural failure modes from Phase 2:
- ✅ tokenBudget self-imposed budget — moved out of agent's control entirely
- ✅ Agent skips final step then claims complete — schema-rejected
- ✅ Agent bypasses tweak via write/edit — only apply_goal_tweak works

The residual ~8% failure rate is genuine model variance (hallucination, comprehension, post-action obedience) that would require either:
- Larger/better model
- Schema-side verification of step_complete evidence (e.g. test commands)
- Stricter "stop when told" prompt block for paused/cleared goals

These are outside the scope of "make pi-goal extension's affordances correct"; they are properties of the LLM under test.
