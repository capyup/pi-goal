# Implemented Borrowed Patterns

This document records external patterns that are actually implemented in `pi-goal` today.

## From pi-codex-goal

`pi-goal` uses several goal-loop stability patterns inspired by `pi-codex-goal`:

- **Goal-id continuation markers**: continuation prompts include a goal id so stale prompts can be detected.
- **Context interceptor**: stale continuation context is neutralized instead of letting an old goal keep driving the agent.
- **Abort pause**: user abort / Ctrl-C pauses the active goal rather than leaving it in a misleading active state.
- **Disk-backed active goal file**: the current objective is materialized on disk and can be audited outside the chat.

## From pi-autoresearch

`pi-goal` uses several autonomous-loop safety patterns inspired by `pi-autoresearch`:

- **Auto-continue cap**: `PI_GOAL_MAX_AUTOCONTINUE_TURNS` prevents runaway continuation chains.
- **Empty-turn gate**: auto-continue does not advance when the agent did no meaningful goal-work tool activity.
- **Post-compaction reminder**: after compaction, the next agent turn is reminded to re-read the objective and continue from actual artifacts/state.

## pi-goal-specific work

The current extension also adds behavior specific to goal drafting and lifecycle safety:

- **Draft-before-run**: `/goal-set` and `/goal-sis` start a drafting interview instead of immediate execution.
- **Confirm-before-commit**: `propose_goal_draft` is the normal creation path; `create_goal` stays hidden.
- **Sisyphus as style**: `/goal-sis` uses the same lifecycle and tools as `/goal-set`; it only changes drafting/continuation wording and completion expectations.
- **Full draft confirmation and creation output**: draft confirmation uses a plain-text report, and after confirmation the finalized objective is printed directly into the conversation.
- **Full completion output**: completion prints a report directly into the conversation, including optional evidence and full goal details.
- **Built-in question tools**: `goal_question` and `goal_questionnaire` provide package-local user-dialogue tools with `goal_` prefixes.
- **Centralized tool names**: published tool names and allowlists live in `goal-tool-names.ts`.
- **Questionnaire componentization**: normalization, answer formatting, proposal confirmation, and question-tool registration live in `goal-questionnaire.ts`.
- **Goal Beacon widget**: the above-editor status display is a dedicated TUI component.

## Current validation

Run locally:

```bash
npm test
npm run check
npm pack --dry-run
```
