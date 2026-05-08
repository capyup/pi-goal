# pi-goal

A pi extension that adds Codex-style long-running goals to pi. It gives you a `/goal` command, agent-visible goal tools, local markdown persistence, and safe autonomous continuation until the agent marks the goal complete.

## Install

Install from GitHub:

```bash
pi install https://github.com/lulucatdev/pi-goal.git
```

Or, from a local checkout:

```bash
pi install .
```

To try the extension once without installing it globally:

```bash
pi -e .
```

After installing, start pi normally in any project and use `/goal` in the TUI.

## Quick Start

Start a goal and let the agent continue autonomously:

```text
/goal improve benchmark coverage for the parser
```

Start a goal with budgets:

```text
/goal --tokens 50k --max-turns 20 improve benchmark coverage for the parser
```

Check status:

```text
/goal status
```

Ask the agent to revise the goal prompt:

```text
/goal tweak focus on parser edge cases before adding broader benchmarks
```

Pause or resume autonomous work:

```text
/goal pause
/goal resume
```

Replace or clear the current goal:

```text
/goal replace --tokens 100k migrate the auth module
/goal clear
```

There is intentionally no `/goal complete` command. The user controls create, pause, resume, replace, and clear. The agent marks the goal complete only by calling `update_goal` when the objective is actually done.

## Command Reference

### `/goal <objective>`

Creates a new active goal. If an unfinished goal already exists, pi asks for confirmation before replacing it.

Examples:

```text
/goal write tests for the payment retry flow
/goal --no-auto keep this migration goal in context but wait for my next instruction
```

### `/goal status`

Shows the active goal, status, elapsed time, token usage, turn count, auto-continue setting, and local file path.

### `/goal tweak <instructions>`

Sends a normal agent-visible message asking the agent to update the active goal file. The extension does not mutate the prompt directly.

Use this when the goal is directionally right but needs refinement:

```text
/goal tweak preserve the original API and only refactor internals
```

The agent is instructed to:

1. Read the active goal file.
2. Edit only the `# Goal Prompt` section.
3. Avoid marking the goal complete just because the prompt changed.
4. Continue working under the revised prompt.

### `/goal pause`

Pauses the current goal. The goal remains in session state and on disk, but pi stops autonomous continuation.

### `/goal resume`

Resumes a paused or budget-limited goal and queues another continuation if auto-continue is enabled.

### `/goal replace <objective>`

Archives the current unfinished goal, then starts a new active goal.

### `/goal clear`

Archives the current unfinished goal and removes it from the active session state. This is user-controlled; the agent cannot clear goals.

## Flags

Flags must appear before the objective.

- `--tokens <n|k|m>` or `--token-budget <n|k|m>`: pause after the estimated model token usage reaches the budget. Examples: `50000`, `50k`, `1.5m`.
- `--max-turns <n>`: pause after this many autonomous goal turns. There is no turn limit by default; `0` also disables the turn limit.
- `--no-auto` or `--no-start`: create the goal and keep it in context, but do not automatically send continuation prompts.
- `--auto` or `--start`: explicitly enable autonomous continuation. This is the default.

## Agent Tools

The extension exposes three tools to the model:

- `get_goal`: read the current goal, status, budgets, usage, elapsed time, and file paths.
- `create_goal`: create a goal only when the user explicitly asks the agent to set one.
- `update_goal`: mark the active goal `complete` when the objective is actually achieved.

`create_goal` and `update_goal` run sequentially to avoid concurrent state mutations. `update_goal` refuses stale in-flight runs if the active goal changed while the agent was working.

## How Autonomous Continuation Works

When a goal is active and auto-continue is enabled, pi injects goal context into the system prompt and starts a continuation turn after the agent has fully returned to idle, including after auto-compaction. Active auto-continue goals are also restarted when the session starts or resumes. Each injected goal message includes a goal id. If the user replaces or clears the goal while a run is in flight, stale continuations and stale completion attempts are ignored.

Autonomous continuation stops when:

- the agent calls `update_goal` with `status=complete`;
- the token budget is reached;
- the configured max-turn budget is reached;
- the user runs `/goal pause` or `/goal clear`;
- the user aborts an agent run, which pauses the goal.

## Local Files

Active goals are written as editable markdown files under `.pi/goals/`:

```text
.pi/goals/active_goal_2026050711200332_<goal-id>.md
```

Archived goals are written under `.pi/goals/archived/`:

```text
.pi/goals/archived/goal_2026050710232343_<goal-id>.md
```

Each file starts with JSON metadata, followed by an editable prompt section:

```markdown
# Goal Prompt

The current goal prompt lives here.

## Progress

- Status: active
- Tokens: 12.4K / 50K
- Turns: 3 / 20
```

The extension treats lifecycle metadata as extension-owned and rereads only the `# Goal Prompt` section from disk before writing progress. This prevents `/goal tweak` edits from being overwritten by stale in-memory state while keeping status, budgets, file paths, and archive transitions controlled by the extension.

For safety, goal file paths are constrained to `.pi/goals/` and `.pi/goals/archived/`. The extension rejects absolute paths, path traversal, NUL bytes, symlinked goal paths, and metadata-provided paths outside the allowed directories.

## Recommended Workflow

1. Start with a concrete objective: `/goal migrate auth tests to the new helper API`.
2. Add budgets for long tasks when desired: `--tokens 100k`, optionally with a turn cap such as `--max-turns 25`.
3. Use `/goal status` when you want to inspect progress.
4. Use `/goal tweak ...` when you want to change direction without bypassing the agent.
5. Use `/goal pause` before manual intervention or risky operations.
6. Let the agent call `update_goal` only when the goal is actually complete.
7. Use `/goal clear` to stop tracking the current goal, or `/goal replace ...` to start a new one.

## Development

Install dependencies and type-check:

```bash
npm install
npm run check
```

Preview the package contents:

```bash
npm pack --dry-run
```

## Notes

This mirrors the main Codex design split: the user controls goal creation, pause, resume, clear, and replacement; the model can only mark the current active goal complete. In pi there is no app-server thread goal API, so state is session-local and branch-aware through custom session entries, with local markdown files as an editable mirror and audit log.
