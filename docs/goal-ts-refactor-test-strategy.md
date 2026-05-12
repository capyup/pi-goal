# Refactor and Test Baseline

This document records the current safety net for the `pi-goal` componentization work.

## Commands

```bash
npm test
npm run check
npm pack --dry-run
```

## Unit test coverage

The fast local suite uses Node's built-in `node:test` runner and currently covers the core modules across:

- `tests/goal-core.test.ts`
- `tests/goal-draft.test.ts`
- `tests/goal-policy.test.ts`
- `tests/goal-questionnaire.test.ts`
- `tests/goal-tool-names.test.ts`

## Extracted modules

`extensions/goal.ts` remains the orchestration layer. The following logic has been extracted and covered by tests:

| Module | Covered behavior |
|---|---|
| `extensions/goal-core.ts` | Token budget parsing, compact duration/token/status display, objective-title cleanup |
| `extensions/goal-draft.ts` | Drafting prompt, draft summary, safe objective escaping, B1 focus gate, Sisyphus prompt-style guidance, drafting tool gate |
| `extensions/goal-policy.ts` | Creation/completion/pause/resume/clear policy, auto-continue cap, budget transition, compaction reminder, full creation/completion reports |
| `extensions/goal-questionnaire.ts` | Question normalization, duplicate id handling, option filtering, recommended-index validation, answer formatting, confirm/cancel mapping, `goal_question` and `goal_questionnaire` registration |
| `extensions/goal-tool-names.ts` | Published tool constants, active-tool list, goal work-tool list, post-stop allowlist, question-like tool detection |
| `extensions/goal-widget.ts` | Goal Beacon rendering, Sisyphus style label, budget/status/path lines, blocker/suggested-action display |

## Refactor rule

1. Add or update tests before moving behavior.
2. Extract pure helpers or narrow adapter boundaries first.
3. Keep published tool names, slash commands, file formats, and UI semantics stable.
4. Run `npm test` and `npm run check` after each slice.
5. Run `npm pack --dry-run` before release or packaging changes.

## Remaining runtime-sensitive areas

The following remain intentionally in `goal.ts` until a stronger mock `ExtensionAPI` / `ExtensionContext` harness exists:

- file IO and archive path handling;
- pi command registration;
- tool registration beyond the questionnaire pair;
- session event hooks;
- timers and auto-continue scheduling;
- live TUI widget rendering.

These areas are protected by TypeScript, focused unit helpers, and the end-to-end experiment harness rather than isolated component tests.
