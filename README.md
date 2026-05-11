# pi-goal

A schema-gated long-running goal extension for [pi](https://github.com/earendil-works/pi-coding-agent). Adds **disciplined autonomous loops** on top of pi's agent session, with two modes (`Goal` and `Sisyphus`), a confirm-before-commit drafting flow, and a stack of schema gates that make the agent obedient where prompt-walls alone cannot.

Backed by a 68-run experimental sweep on `fireworks/kimi-k2p6-turbo` (thinking=high): **63/68 = 92.6%** full-pass; all 11 user-requested behaviors have a runtime test case.

## Why this exists

A "long-running goal" loop sounds easy: hold an objective in the system prompt, queue a checkpoint after each turn, stop when the model says it's done. In practice the model:

- forgets the goal across context compaction;
- self-invents reconnaissance steps the user didn't ask for;
- marks the goal "complete" when it gets bored or runs low on tokens;
- keeps writing files after `pause_goal` fires;
- gets confused about which goal id is current;
- ignores prompt-level rules whenever they conflict with momentum.

This extension answers **every one of those** with a schema-level gate, not a stronger prompt. Each gate has a runtime test case in `experiments/cases/`.

## Install

From a local checkout:

```bash
pi install .
```

From GitHub:

```bash
pi install npm:@capyup/pi-goal
```

Or from the GitHub source:

```bash
pi install https://github.com/capyup/pi-goal.git
```

Try once without installing:

```bash
pi -e .
```

After install, open pi in any project and use the `/goal-set` or `/goal-sis` slash commands.

## Quick start

### Regular goal (open-ended)

```text
/goal-set add structured logging to the auth module
```

What happens:

1. Drafting starts. The agent interviews you in 1-3 turns.
2. When ready, the agent calls `propose_goal_draft`.
3. A confirm dialog appears with the proposed objective + criteria.
4. Hit **Confirm** to commit, or **Continue Chatting** to keep refining.
5. After confirm, `autoContinue` kicks in: the agent works in checkpoint turns until it calls `update_goal=complete` or you press Esc.

### Sisyphus goal (strict step-by-step)

```text
/goal-sis "Refactor: 1) extract the validator. 2) wire it into the request handler. 3) update tests."
```

Sisyphus mode adds a **step counter**. The agent MUST call `step_complete` once per step (in order). `update_goal=complete` is rejected by the schema until all steps have been marked done.

### Status, tweaks, pause, resume, clear

```text
/goal-status                              # current state
/goal-tweak focus on the validator first  # propose a revision
/goal-pause                               # pause autoContinue
/goal-resume                              # resume from a paused goal
/goal-clear                               # archive the current goal
```

Pressing **Esc** while the agent is running pauses the active goal and stops the autoContinue chain.

## Modes

| Mode | Slash command | When to use | Schema features |
|------|---------------|-------------|-----------------|
| Goal | `/goal-set` | Open-ended objective with a success criterion | Free-form objective; agent decides next step each checkpoint |
| Sisyphus | `/goal-sis` / `/sis` | Concrete linear plan with N ordered steps | `step_complete` schema enforces 1-per-step, in-order, with optional `verifyCommand` |

## Drafting & confirmation flow

`/goal-set` and `/goal-sis` both enter **drafting mode**. Drafting is a normal conversation but with a schema-enforced tool whitelist:

- Allowed: `propose_goal_draft`, `get_goal`
- Blocked (with a `{block:true}` message): `bash`, `write`, `edit`, `read`, `grep`, `find`, `ls`, …

This forces the agent to **ask you instead of reconnoitering your repo** before committing to a goal. When ready, the agent calls `propose_goal_draft({sisyphus, objective, autoContinue, …})`. The extension shows a confirm dialog:

```
┌─ Proposed Goal ─────────────────────────────────┐
│ === Goal ===                                    │
│ Objective: …                                    │
│ Success criteria: …                             │
│ Boundaries: …                                   │
│ Constraints: …                                  │
│                                                 │
│ [Confirm]    [Continue Chatting]                │
└─────────────────────────────────────────────────┘
```

- **Confirm**: commits the goal, hides `propose_goal_draft`, exposes the work tools, kicks off autoContinue if enabled.
- **Continue Chatting** (or **Esc**): drafting continues. No place to get stuck.
- Headless mode (no TUI) auto-confirms — the test harness uses this path.

## Agent tools

All tools follow the **"only show what's relevant right now"** rule. Tool surface depends on lifecycle phase:

| Tool | Visible when | Purpose |
|------|--------------|---------|
| `get_goal` | always | Read the current goal record |
| `propose_goal_draft` | drafting only | Propose a goal for user confirmation |
| `apply_goal_tweak` | tweak-drafting only | Propose a revision to the active goal |
| `update_goal` | goal active | Mark `complete` (sisyphus: requires all `step_complete` first) |
| `pause_goal` | goal active | Pause due to a real blocker; auto-pauses autoContinue |
| `step_complete` | sisyphus active | Mark step N done; optional `verifyCommand` |
| `create_goal` | **hidden** | Internal-only; users always commit via the confirm dialog |

## Schema gates (the actual product)

Each gate addresses a specific failure mode observed in real runs. Every gate has a runtime test case.

### Drafting layer (Phase 5)

| Gate | What it prevents | Schema location | Test case |
|------|------------------|-----------------|-----------|
| **B1 Focus consistency** | `/goal-set` accidentally producing a sisyphus goal | `propose_goal_draft` validator: `sisyphus !== (focus === "sisyphus")` → reject | C12 5/5 |
| **B2 Plan-step preservation** | Agent inflating a 2-step plan into 5 with self-invented "step 0: check…" | `propose_goal_draft` validator: rejects sisyphus proposals with step count > user's + 1 | C13 5/5 |
| **C3 Drafting tool whitelist** | Agent calling `bash ls` for "context" before drafting | `pi.on("tool_call")` blocks workhorse tools during `draftingFor !== null` | C11 4/5 |
| **D Confirm dialog** | Agent committing a goal you wouldn't approve | `propose_goal_draft` shows `SelectList` overlay; only confirm reaches `setGoal` | all 16 runtime cases |

### Execution layer (Phase 4)

| Gate | What it prevents | Schema location | Test case |
|------|------------------|-----------------|-----------|
| **Stale context interceptor** | Old `[GOAL CHECKPOINT goalId=…]` blocks surviving after `update_goal=complete` | `pi.on("context")` rewrites stale checkpoint into a hidden notice | covered by C7, C9 |
| **`step_complete.verifyCommand`** | Agent claiming step done without artifact proof | `step_complete` schema executes the `bash -c verifyCommand` and rejects on non-zero | C10 (5/5 then 2/3) |
| **`MAX_AUTOCONTINUE_TURNS=30`** | Runaway autoContinue chains on chat-only loops | hard cap in `queueContinuation`; env-configurable | C17 3/3 |
| **Sisyphus empty-turn gate** | autoContinue firing when the agent did no real work | Tracks `sisyphusToolCalledThisTurn`; skips queue on empty turn | C3 / C6 |
| **Post-compaction resync** | Agent losing step counter across compaction | Arms `postCompactReminderPending`; injects `[POST-COMPACTION RESYNC]` block on next agent start | C16 1/1 |
| **`pauseForAbort`** | Goal staying "active" after Ctrl-C / abort | `turn_end` / `message_end` detect `stopReason="aborted"` → `pauseActiveGoal` | C18 3/3 |
| **`turnStoppedFor` post-stop block** | Agent writing more files after `pause_goal` or `update_goal=complete` | `pi.on("tool_call")` blocks all non-`get_goal` tools in that same turn | C9 5/5 |

### Structured output (borrowed)

- **`<pi_goal_continuation goal_id="…">` prefix** (from pi-codex-goal): XML wrapper around checkpoint prompts. Older `[GOAL CHECKPOINT goalId=…]` markers stay supported via fallback regex.
- **`METRIC name=value` lines** (from pi-autoresearch): `step_complete` result text includes `METRIC step=N total=M done=K verifyCommand=passed|absent evidence_chars=L` so external graders can parse without LLM intervention.

## Local files

```
.pi/goals/active_goal_<ts>_<id>.md     # active goal
.pi/goals/archived/goal_<ts>_<id>.md   # archived (cleared / replaced / completed)
```

Each file starts with a JSON block (extension-owned: status, autoContinue, usage, sisyphus, currentStep, …), followed by the user-editable `# Goal Prompt` section. The extension only re-reads `# Goal Prompt` from disk — lifecycle metadata is owned by the extension and reset on every write.

Path safety: goal paths are constrained to `.pi/goals/` and `.pi/goals/archived/`. Absolute paths, traversal, NUL bytes, symlinks, and metadata-supplied paths outside the allowed dirs are rejected.

## Environment variables

| Var | Default | Use |
|-----|---------|-----|
| `PI_GOAL_MAX_AUTOCONTINUE_TURNS` | `30` | Hard cap for consecutive autoContinue turns. Clamped to 1-1000. Set this to a low value (e.g. `3`) in tests to exercise the cap quickly. |
| `PI_GOAL_AUTO_CONFIRM` | unset | When set to `1` (or running headless without a UI), `propose_goal_draft` auto-confirms. Used by the test harness. |

## Experimental results

18 cases, 68 runs, on `fireworks/kimi-k2p6-turbo` + thinking=high + 360s/turn:

| Phase | Cases | Pass | Rate | Key milestone |
|-------|-------|------|------|---------------|
| Phase 2 | 9 | 42/45 | 93.3% | `tokenBudget` schema removal |
| Phase 3 | 9 | 44/48 | 91.7% | `step_complete` counter, `apply_goal_tweak` gate |
| Phase 4 | 10 | 38/40 | 95.0% | `verifyCommand`, `turnStoppedFor`, autocontinue cap, empty-turn gate, post-compact resync |
| **Phase 5** | **18** | **63/68** | **92.6%** | `propose_goal_draft` confirm dialog, B1/B2/C3 drafting gates, env-configurable cap, abort harness |

### All 11 user-requested behaviors covered

| # | Behavior | Mechanism | Case | Result |
|---|----------|-----------|------|--------|
| 🔴 B1 | Focus vs sisyphus | schema gate | C12 | **5/5** |
| 🔴 B2 | Plan step preservation | schema gate | C13 | **5/5** |
| 🟡 B3 | Compaction-then-resume | runtime | C16 | **1/1** |
| 🟡 B4 | Abort / Ctrl-C | runtime (new harness) | C18 | **3/3** |
| 🟡 B5 | `MAX_AUTOCONTINUE_TURNS` | runtime (new env.json) | C17 | **3/3** |
| 🟢 B6 | `budgetLimited` transition | runtime | C15 | 3/4 |
| 🟢 B7 | Post-stop tool block | runtime + indirect via C9 | C14, C9 | C9 **5/5** |
| C1 | `pi_goal_continuation` prefix | structural | code | verified |
| C2 | `METRIC name=value` output | structural | code | verified |
| C3 | Drafting tool whitelist | schema gate | C11 | 4/5 |
| D | `propose_goal_draft` confirm | new commit path | all 16 runtime cases | exercised |

Full per-case breakdown: [`experiments/README.md`](experiments/README.md). Iteration history: [`experiments/observations/iteration-log.md`](experiments/observations/iteration-log.md).

## Development

```bash
npm install
npm run check        # tsc --noEmit; ~2800-line file, must stay clean
npm pack --dry-run   # preview package contents
```

### Running the experiment harness

```bash
cd experiments
bash harness/run.sh C1-vague-goal-set --count 3 --grade --no-smoke
# → experiments/cases/C1-vague-goal-set/runs/<ts>/score.md
```

Harness affordances:

| Affordance | Where | Purpose |
|------------|-------|---------|
| `<case>/compaction.json` | per case | Enable in-test compaction with `{ "enabled": true, "thresholdTokens": N }` |
| `<case>/env.json` | per case | Override extension env (loaded BEFORE extension import) |
| `ABORT_AFTER_MS: <N>` | `INPUT.md` directive | Schedule `session.abort()` N ms after the next TURN |
| `raw-ndjson-contains` | rubric kind | Match harness markers in the raw event stream |
| `tool-call-count.argsJq` | rubric kind | Count tool calls whose args match a jq filter |

### Adding a new case

1. `mkdir experiments/cases/Cxx-<name>/`
2. Write `INPUT.md` with one or more `TURN: …` lines.
3. Write `rubric.json` as an array of `{id, desc, kind, …}` checks.
4. (optional) `compaction.json`, `env.json`, `seed.sh`.
5. `bash harness/run.sh Cxx-<name> --grade --no-smoke`

Supported rubric kinds: `tool-called`, `tool-not-called`, `tool-call-count`, `tool-args-jq`, `tool-args-jq-none`, `final-text-matches`, `final-text-not-matches`, `sandbox-file-exists`, `sandbox-file-contains`, `sandbox-glob-exists`, `sandbox-glob-not-exists`, `sandbox-glob-contains`, `raw-ndjson-contains`, `usage-output-le`.

## Design principles

- **Intent ownership**: only humans create / replace / clear / resume goals. The agent's only state-mutating verbs are `propose_goal_draft` (asks), `update_goal` (marks complete), `pause_goal` (blocked), `step_complete` (one step done), `apply_goal_tweak` (revises). All are schema-gated.
- **Schema beats prompt**: every recurring failure was eventually closed by a schema gate, never by a stronger prompt. Phase 4 & 5 systematically converted prompt rules into validators, tool whitelists, or tool-call interceptors.
- **Tools follow lifecycle**: tool surface is recomputed on every state change. The agent only sees tools that make sense for the current phase, eliminating an entire class of "wrong tool at wrong time" failures.
- **One commit path**: `create_goal` is hidden. Every goal commits through drafting → `propose_goal_draft` → confirm dialog. No shortcuts, no command-line bypass.
- **Test what you ship**: every gate has a runtime test case under `experiments/cases/`. The harness uses real LLM calls (no mocks), graded by mechanical rubrics.

## Acknowledgements

This extension synthesizes patterns from two upstream projects:

- [**pi-codex-goal**](https://github.com/fitchmultz/pi-codex-goal) by Mitch Fultz: contributed the `pi.on("context")` stale-continuation interceptor, the `<pi_goal_continuation>` XML wrapper, and the `pauseForAbort` pattern.
- [**pi-autoresearch**](https://github.com/davebcn87/pi-autoresearch) by David Cortés: contributed the `MAX_AUTORESUME_TURNS` cap, the `shouldAutoResumeAfterTurn` empty-turn gate, the `checks.sh` style schema verification (adapted as `step_complete.verifyCommand`), the tool-whitelist-in-disciplined-mode idea (adapted as drafting whitelist), and `METRIC name=value` structured output.

## License

MIT
