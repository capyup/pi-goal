import assert from "node:assert/strict";
import test from "node:test";

import type { Theme } from "@earendil-works/pi-coding-agent";
import { renderGoalWidgetLines, type GoalWidgetRecord } from "../extensions/widgets/goal-widget.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

function goal(overrides: Partial<GoalWidgetRecord> = {}): GoalWidgetRecord {
	return {
		objective: "=== Goal ===\nObjective: Componentize the goal widget\nSuccess criteria: tests pass",
		status: "active",
		autoContinue: true,
		tokenBudget: 10_000,
		usage: { activeSeconds: 65, tokensUsed: 2500 },
		sisyphus: true,
		activePath: ".pi/goals/active_goal.md",
		...overrides,
	};
}

test("renderGoalWidgetLines renders a distinct Sisyphus goal beacon", () => {
	const lines = renderGoalWidgetLines(goal(), theme, 100);
	assert.match(lines[0], /^◆ Sisyphus running/);
	assert.match(lines[0], /auto · 1m05s · 2\.5K/);
	assert.doesNotMatch(lines[0], /▰|▱/);
	assert.match(lines[1], /^├─ ⟡ Componentize the goal widget/);
	assert.doesNotMatch(lines.join("\n"), /pulse/);
	assert.match(lines[2], /^├─ budget 10K .* remaining 7\.5K/);
	assert.match(lines.at(-1) ?? "", /^└─ \.pi\/goals\/active_goal\.md/);
});

test("renderGoalWidgetLines merges complete usage into the heading", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "complete",
		autoContinue: false,
		sisyphus: false,
		archivedPath: ".pi/goals/archived/goal.md",
	}), theme, 100);
	assert.match(lines[0], /^✓ Goal complete/);
	assert.match(lines[0], /1m05s · 2\.5K/);
	assert.doesNotMatch(lines.join("\n"), /pulse/);
});


test("renderGoalWidgetLines highlights agent blockers and suggested action", () => {
	const lines = renderGoalWidgetLines(goal({
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: "Missing API token",
		pauseSuggestedAction: "Set TOKEN and run /goal-resume",
	}), theme, 100);
	assert.match(lines[0], /⊘ Sisyphus blocked/);
	assert.match(lines.join("\n"), /^├─ blocker Missing API token/m);
	assert.match(lines.join("\n"), /^├─ next Set TOKEN and run \/goal-resume/m);
});

test("renderGoalWidgetLines shows other open goals and unfocused multi-goal guidance", () => {
	const focused = renderGoalWidgetLines(goal(), theme, 100, { openGoalCount: 3 });
	assert.match(focused[0], /\+2 open/);

	const unfocused = renderGoalWidgetLines(null, theme, 100, { openGoalCount: 2 });
	assert.match(unfocused[0], /^◇ Goal unfocused/);
	assert.match(unfocused[0], /2 open/);
	assert.match(unfocused.join("\n"), /\/goal-focus/);
});
