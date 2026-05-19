# Changelog

All notable changes to pi-goal-x are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
with the `0.x` prefix indicating pre-1.0 development.

---

## [0.8.1] — 2026-05-19

### Changed

- **Audit log messages clarified**: `extensions/goal.ts` — disabled/aborted audit messages now read naturally as goal completion notices ("Goal completed — auditor disabled in settings." / "Goal completed — auditor bypassed (user pressed Escape during audit).").

---

## [0.8.0] — 2026-05-17

### Added

- **C19 iteration-frustration benchmark**: new spec under `specs/` exercising the proposal-refinement cycle with repeated rejection scenarios.
- Spec metadata files: `PRODUCT.md`, `TECH.md`, `MILESTONES.md` for the C19 benchmark.

### Changed

- **Normalized proposal-refinement cycle language**: `extensions/goal-draft.ts`, `extensions/goal-questionnaire.ts`, and `extensions/goal.ts` — consistent terminology across the drafting/refinement pipeline.
- Updated test assertions (`tests/goal-draft.test.ts`) to match the new language.

---

## [0.7.2] — 2026-05-17

### Added

- Gallery image metadata and placeholder screenshot for `pi.dev/packages`.

---

## [0.7.1] — 2026-05-17

### Fixed

- Version metadata in package manifest after 0.7.0 release commit.

---

## [0.7.0] — 2026-05-17

### Added

- **Goal auditor lifecycle** (`feat(auditor)`):
  - `disabled` config flag to turn off auditing entirely.
  - Real-time progress callbacks during audit execution.
  - `audit_skipped` event type recorded in the ledger with reason + auditor metadata.
- **Auditor progress widget**: live spinner, tool tracking, and skip hint in the TUI.
- **Auditor integration**:
  - Escape-key handling during audit (skip with Esc, prevents cascading goal pause).
  - `createSession` factory wiring `AbortSignal` to `session.abort()`.
  - Audit abort detection (both thrown and non-thrown `session.prompt` aborts).
  - Goal completes on audit abort instead of leaving an open state.

### Fixed

- Audit cancellation loop: `confirmBypassAuditor` param respected, skip-once with `triggerTurn` mirroring disabled-bypass path.
- Corrected Esc-to-skip widget message to reflect actual behavior.

### Tests

- Unit tests for disabled config, `audit_skipped` events, and widget skip hint.
- Abort-scenario tests for `runGoalCompletionAuditor`.
- Post-prompt abort detection test.
- Goal policy test validating completion report includes full auditor output.

---

## [0.6.0] — 2026-05-12

### Added

- **Split goal intent and direct set commands**: `/goals-set` / `/sisyphus-set` — create and start a goal immediately from the supplied objective, skipping the discussion flow.

### Changed

- `specs/` directory excluded from npm package.

---

## [0.5.0] — 2026-05-12

### Removed

- Token budget system removed from the drafting runtime.
- **Simplified drafting runtime**: removed token-budget tracking and associated complexity.

---

## [0.4.1] — 2026-05-12

### Added

- **Visible audit dialogue**: the completion auditor now prints its dialogue into the conversation, giving full visibility into the audit reasoning.

---

## [0.4.0] — 2026-05-12

### Changed

- Goal runtime updates — internal refactoring and lifecycle improvements.

---

## [0.3.1] — 2026-05-12

### Added

- **Independent goal completion auditor**: standalone audit step that reviews goal completion before finalizing.

---

## [0.3.0] — 2026-05-12

### Fixed

- **Oracle goal lifecycle audit fixes**: corrected audit lifecycle handling in Oracle-based goal execution.

---

## [0.2.7] — 2026-05-12

### Added

- **Goal abort lifecycle**: proper abort handling for in-progress goals.

---

## [0.2.6] — 2026-05-12

### Changed

- Split goal internals — refactored monolithic goal module into focused sub-modules.

---

## [0.2.5] — 2026-05-12

### Added

- Full `/sisyphus` command now required (no short-form aliases that could cause ambiguity).

---

## [0.2.4] — 2026-05-12

### Changed

- Grouped goal widgets — reorganized widget components for maintainability.

---

## [0.2.3] — 2026-05-12

### Changed

- Simplified Sisyphus goal flow — streamlined the Sisyphus execution loop.

---

## [0.2.2] — 2026-05-12

### Fixed

- Simplified goal widget header — removed redundant status information from the widget display.

---

## [0.2.1] — 2026-05-12

### Added

- **Goal widget component**: initial TUI widget showing goal status in the editor.

---

## [0.2.0] — 2026-05-12

### Added

- **Componentized goal drafting UX**: `/goals` and `/sisyphus` drafting flow extracted into reusable components.

---

## [0.1.2] — 2026-05-11

### Fixed

- Built-in question tools now correctly prefixed to avoid naming collisions.

---

## [0.1.1] — 2026-05-11

### Added

- **Built-in goal questionnaire drafting UI**: interactive questionnaire for goal refinement before confirmation.

---

## [0.1.0] — 2026-05-11

### Added

- Initial release of pi-goal-x (fork of `@capyup/pi-goal`).
- Core goal lifecycle: draft, confirm, execute, pause, resume, complete.
- Two goal styles: regular goals and Sisyphus ordered-execution goals.
- Intent-before-run flow (`/goals`, `/sisyphus`).
- `propose_goal_draft` confirmation gate.
- Auto-continue loop with empty-turn guard.
- Schema-gated lifecycle transitions.
- Multiple open goals with session-local focus.
- Goal status overlay widget.
- MIT license.

<!-- Version links for navigation -->

[0.8.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.8.1
[0.8.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.8.0
[0.7.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.2
[0.7.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.1
[0.7.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.7.0
[0.6.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.6.0
[0.5.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.5.0
[0.4.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.4.1
[0.4.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.4.0
[0.3.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.3.1
[0.3.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.3.0
[0.2.7]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.7
[0.2.6]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.6
[0.2.5]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.5
[0.2.4]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.4
[0.2.3]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.3
[0.2.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.2
[0.2.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.1
[0.2.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.2.0
[0.1.2]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.2
[0.1.1]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.1
[0.1.0]: https://github.com/tmonk/pi-goal-x/releases/tag/v0.1.0
