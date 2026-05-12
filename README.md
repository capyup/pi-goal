# pi-goal

`pi-goal` is a long-running goal extension for [pi](https://github.com/earendil-works/pi-coding-agent). It gives the agent a durable objective, a visible lifecycle, and schema-gated tools for drafting, executing, pausing, resuming, and completing work.

The extension is designed around one rule: **the user owns intent; the agent executes only after the goal is explicit and confirmed**.

## What it provides

- **Two goal styles**: regular goals for open-ended work, and Sisyphus goals for patient ordered execution.
- **Draft-before-run flow**: `/goal-set` and `/goal-sis` start a drafting conversation before any work begins.
- **Confirm-before-commit**: the agent must call `propose_goal_draft`; the user confirms or keeps chatting.
- **Full goal visibility**: after confirmation, the final objective is printed back into the conversation in full.
- **Auto-continue loop**: confirmed goals can continue across turns until completion, pause, budget limit, abort, or user interruption.
- **Schema gates**: unsafe lifecycle transitions are rejected by tool validators, not just prompts.
- **Sisyphus as a light variant**: Sisyphus shares the normal lifecycle/tools and differs only in prompt style and completion standard.
- **Pause/resume/clear lifecycle**: goals can be paused by the user, paused by the agent when blocked, resumed, or archived.
- **Disk-backed state**: active and archived goals are stored under `.pi/goals/`.
- **Lightweight built-in questionnaire tools**: `goal_question` and `goal_questionnaire` let the agent ask structured drafting questions without depending on another package.
- **Above-editor status widget**: pi shows the current goal, status, budget, progress, and active file path while work is running.

## Install

From npm:

```bash
pi install npm:@capyup/pi-goal
```

From a local checkout:

```bash
pi install .
```

Try once without installing:

```bash
pi -e .
```

## Quick start

### Regular goal

```text
/goal-set add structured logging to the auth module
```

Flow:

1. The agent asks any needed clarifying questions.
2. The agent calls `propose_goal_draft` with a concrete objective.
3. pi shows a full plain-text confirmation report.
4. If confirmed, the full finalized goal is printed into the conversation and written to `.pi/goals/`.
5. The agent works until it calls `update_goal(status="complete")`, pauses, hits a budget/cap, or the user interrupts.

### Sisyphus goal

```text
/goal-sis Refactor the auth flow: 1) extract token validation. 2) wire it into login. 3) update tests.
```

Sisyphus mode is for patient ordered execution. It uses the same lifecycle and tools as a regular goal; the difference is the prompt style and completion standard: preserve the user's order, do not rush, do not invent preflight/reconnaissance steps, and stop to ask when blocked.

## User commands

```text
/goal-set <topic>       Start drafting a regular goal
/goal-sis <topic>       Start drafting a Sisyphus-style goal
/sis <topic>            Alias for /goal-sis
/goal-status            Show current goal state
/goal-tweak <change>    Draft a revision to the active/paused goal
/goal-pause             Pause the active goal
/goal-resume            Resume a paused goal
/goal-clear             Archive the active goal or cancel drafting
```

Pressing `Esc` or aborting an active run pauses the goal so it does not remain falsely active.

## Agent tools

The extension exposes tools only when they make sense for the current lifecycle phase.

| Tool | Visible when | Purpose |
|---|---|---|
| `goal_question` | drafting / tweak drafting | Ask one focused user question |
| `goal_questionnaire` | drafting / tweak drafting | Ask multiple structured questions |
| `get_goal` | always | Read current goal state |
| `propose_goal_draft` | goal drafting only | Submit a concrete draft for user confirmation |
| `apply_goal_tweak` | tweak drafting only | Submit a revision to an existing goal |
| `update_goal` | active goal | Mark the goal complete when all requirements are satisfied |
| `pause_goal` | active goal | Pause because of a real blocker |
| `step_complete` | hidden / legacy | Compatibility no-op; Sisyphus no longer requires a step counter |
| `create_goal` | hidden | Internal compatibility path; normal creation goes through `propose_goal_draft` |

## Drafting behavior

During `/goal-set`, `/goal-sis`, or `/goal-tweak`, the agent is in an interview phase. It may ask questions through normal chat, `goal_question`, or `goal_questionnaire`, but workhorse tools are blocked.

Allowed during goal drafting:

- `goal_question`
- `goal_questionnaire`
- `get_goal`
- `propose_goal_draft`

Blocked during goal drafting:

- shell/file/search tools such as `bash`, `read`, `write`, `edit`, `grep`, `find`, `ls`
- lifecycle tools that would mutate execution state before the user confirms

When a draft is proposed, the confirmation UI shows a full plain-text report with draft details, the original topic, and the proposed goal. When it is confirmed, the tool result includes the full final objective, not a one-line summary. This makes the confirmed contract visible in the conversation as well as on disk.

## Completion behavior

Completion is also explicit. The agent should call:

```json
{"status":"complete","completionSummary":"What was completed and what evidence proves it."}
```

The completion result prints a full report into the conversation:

- `Goal complete.`
- optional completion summary / evidence supplied by the agent
- full current goal details, including objective, status, usage, budget, mode, and file path

Sisyphus goals use the same completion tool as regular goals. The stricter part is the prompt/criteria standard: the agent should only complete after the whole ordered objective is actually satisfied.

## Schema gates

The shipped gates are intentionally small and mechanical.

| Gate | Prevents |
|---|---|
| Drafting tool whitelist | The agent doing repo reconnaissance before the user confirms a goal |
| Focus consistency | `/goal-set` accidentally becoming Sisyphus, or `/goal-sis` becoming regular mode |
| Confirm-before-commit | The agent silently creating or replacing a goal |
| Completion gate | Completing paused, stale, missing, or unfinished goals |
| Post-stop block | Continuing to call tools after `pause_goal`, `update_goal`, or `apply_goal_tweak` stops the turn |
| Auto-continue cap | Runaway continuation chains |
| Abort pause | Active goals staying active after user abort / Ctrl-C |
| Post-compaction reminder | Losing the active objective after session compaction |

## Files

```text
.pi/goals/active_goal_<timestamp>_<id>.md
.pi/goals/archived/goal_<timestamp>_<id>.md
```

Each file contains:

1. extension-owned JSON metadata;
2. a user-editable `# Goal Prompt` section;
3. progress/status information.

The extension re-reads only the `# Goal Prompt` body from disk. Lifecycle metadata remains controlled by the extension.

Goal paths are constrained to `.pi/goals/` and `.pi/goals/archived/`; absolute paths, traversal, NUL bytes, symlinks, and unsafe metadata paths are rejected.

## Environment variables

| Variable | Default | Purpose |
|---|---:|---|
| `PI_GOAL_MAX_AUTOCONTINUE_TURNS` | `30` | Hard cap for consecutive auto-continue turns, clamped to 1-1000 |
| `PI_GOAL_AUTO_CONFIRM` | unset | When `1`, auto-confirms drafts in headless/test contexts |

## Development

```bash
npm install
npm test
npm run check
npm pack --dry-run
```

The fast unit suite uses Node's built-in test runner and covers core parsing, drafting gates, lifecycle policy, questionnaire formatting, centralized tool names, Sisyphus prompt-style behavior, completion reporting, and display helpers.

The experiment harness under `experiments/` runs full pi sessions against real model calls and mechanical rubrics.

```bash
cd experiments
bash harness/run.sh C1-vague-goal-set --count 3 --grade --no-smoke
```

## Package contents

The npm package ships only the runtime extension, docs, and package metadata. The extension is split into small modules:

```text
extensions/goal.ts                 orchestration, commands, file IO, events, timers
extensions/goal-core.ts            parsing and display helpers
extensions/goal-draft.ts           drafting prompt, proposal validation, drafting tool gate
extensions/goal-policy.ts          lifecycle, pause/resume/complete, Sisyphus, budget policy
extensions/goal-questionnaire.ts   built-in question UI and question tool registration
extensions/goal-tool-names.ts      centralized published tool names and allowlists
extensions/goal-widget.ts          above-editor goal beacon component
```

## Design principles

- **User owns intent**: only the user starts, replaces, resumes, clears, or confirms goals.
- **One commit path**: normal goal creation goes through drafting and confirmation.
- **Schema beats prompt walls**: recurring failure modes are handled by validators and tool-call interceptors.
- **Visible contracts**: confirmed goals and completion reports are printed fully into the conversation.
- **Lifecycle-shaped tool surface**: the agent sees only tools appropriate to the current phase.
- **Disk-backed continuity**: goal state survives context churn and can be audited from `.pi/goals/`.

## License

MIT
