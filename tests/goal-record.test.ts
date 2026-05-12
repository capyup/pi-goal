import assert from "node:assert/strict";
import test from "node:test";

import {
	cloneGoal,
	createGoal,
	goalFocusDetails,
	normalizeGoalFocusEntry,
	normalizeGoalRecord,
	type GoalCreationConfig,
} from "../extensions/goal-record.ts";

const baseConfig: GoalCreationConfig = {
	objective: "=== Goal ===\nObjective: ship the refactor",
	autoContinue: true,
	tokenBudget: 1200,
	sisyphus: false,
};

test("createGoal builds stable goal records with fresh usage and requested mode", () => {
	const goal = createGoal(baseConfig, Date.UTC(2026, 0, 2, 3, 4, 5));

	assert.equal(goal.objective, baseConfig.objective);
	assert.equal(goal.status, "active");
	assert.equal(goal.autoContinue, true);
	assert.equal(goal.tokenBudget, 1200);
	assert.equal(goal.sisyphus, false);
	assert.deepEqual(goal.usage, { tokensUsed: 0, activeSeconds: 0 });
	assert.equal(goal.createdAt, "2026-01-02T03:04:05.000Z");
	assert.equal(goal.updatedAt, "2026-01-02T03:04:05.000Z");
	assert.match(goal.id, /^[a-z0-9]+-[a-z0-9]+$/);
});

test("normalizeGoalRecord preserves known fields while sanitizing unsafe or missing values", () => {
	const normalized = normalizeGoalRecord({
		id: "goal-123",
		objective: "  Keep behavior  ",
		status: "paused",
		stopReason: "agent",
		pauseReason: "blocked",
		pauseSuggestedAction: "ask user",
		autoContinue: false,
		tokenBudget: 99.9,
		usage: { tokensUsed: 12.9, activeSeconds: 7.2 },
		sisyphus: true,
		activePath: ".pi/goals/active.md",
		archivedPath: ".pi/goals/archived/old.md",
		createdAt: "2026-02-03T04:05:06.000Z",
		updatedAt: "2026-02-03T04:06:06.000Z",
	});

	assert.ok(normalized);
	assert.equal(normalized.id, "goal-123");
	assert.equal(normalized.objective, "Keep behavior");
	assert.equal(normalized.status, "paused");
	assert.equal(normalized.stopReason, "agent");
	assert.equal(normalized.pauseReason, "blocked");
	assert.equal(normalized.pauseSuggestedAction, "ask user");
	assert.equal(normalized.autoContinue, false);
	assert.equal(normalized.tokenBudget, 99);
	assert.deepEqual(normalized.usage, { tokensUsed: 12, activeSeconds: 7 });
	assert.equal(normalized.sisyphus, true);
	assert.equal(normalized.activePath, ".pi/goals/active.md");
	assert.equal(normalized.archivedPath, ".pi/goals/archived/old.md");
	assert.equal(normalized.createdAt, "2026-02-03T04:05:06.000Z");
	assert.equal(normalized.updatedAt, "2026-02-03T04:06:06.000Z");
});

test("cloneGoal returns a detached usage object", () => {
	const goal = createGoal(baseConfig, Date.UTC(2026, 0, 2, 3, 4, 5));
	const cloned = cloneGoal(goal);
	cloned.usage.tokensUsed = 500;

	assert.equal(goal.usage.tokensUsed, 0);
	assert.equal(cloned.usage.tokensUsed, 500);
});

test("goal focus entries persist only session focus metadata", () => {
	assert.deepEqual(goalFocusDetails("goal/123", "created"), {
		version: 1,
		focusedGoalId: "goal_123",
		reason: "created",
	});
	assert.deepEqual(goalFocusDetails(null, "cleared"), {
		version: 1,
		focusedGoalId: null,
		reason: "cleared",
	});

	assert.deepEqual(normalizeGoalFocusEntry({ version: 1, focusedGoalId: "abc/def", reason: "resumed" }), {
		version: 1,
		focusedGoalId: "abc_def",
		reason: "resumed",
	});
	assert.deepEqual(normalizeGoalFocusEntry({ version: 1, focusedGoalId: "", reason: "unknown" }), {
		version: 1,
		focusedGoalId: null,
		reason: "selected",
	});
	assert.equal(normalizeGoalFocusEntry({ version: 3, focusedGoalId: "abc" }), null);
});
