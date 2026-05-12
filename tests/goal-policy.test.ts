import assert from "node:assert/strict";
import test from "node:test";

import {
	buildAutoContinueCapPause,
	buildCompletionReport,
	buildGoalCreatedReport,
	buildPausedByAgentGoal,
	clearGoalCommandMessage,
	isGoalUnfinished,
	shouldArmPostCompactReminder,
	shouldAutoPauseForContinueCap,
	shouldInjectPostCompactReminder,
	shouldQueueContinuation,
	statusAfterBudgetLimit,
	validateGoalCompletion,
	validateGoalCreationSlot,
	validatePauseGoal,
	validateResumeGoal,
	type GoalPolicyRecordLike,
} from "../extensions/goal-policy.ts";

function goal(overrides: Partial<GoalPolicyRecordLike> = {}): GoalPolicyRecordLike {
	return {
		id: "g1",
		objective: "=== Goal ===\nObjective: test",
		status: "active",
		autoContinue: true,
		tokenBudget: null,
		usage: { tokensUsed: 0, activeSeconds: 0 },
		sisyphus: false,
		updatedAt: "2026-05-12T00:00:00.000Z",
		...overrides,
	};
}

function sisyphus(overrides: Partial<GoalPolicyRecordLike> = {}): GoalPolicyRecordLike {
	return goal({
		objective: "=== Sisyphus Goal ===\nSteps:\n1. A\n2. B",
		sisyphus: true,
		...overrides,
	});
}

function rejectedMessage(result: { ok: true } | { ok: false; message: string }): string {
	assert.equal(result.ok, false);
	return result.message;
}

test("goal lifecycle creation and completion gates reject unsafe transitions", () => {
	assert.equal(isGoalUnfinished(null), false);
	assert.equal(isGoalUnfinished(goal({ status: "active" })), true);
	assert.equal(isGoalUnfinished(goal({ status: "complete" })), false);

	assert.deepEqual(validateGoalCreationSlot(null), { ok: true });
	assert.match(rejectedMessage(validateGoalCreationSlot(goal({ status: "paused" }))), /unfinished goal/);

	assert.deepEqual(validateGoalCompletion({ goal: goal({ sisyphus: false }) }), { ok: true });
	const noGoal = validateGoalCompletion({ goal: null });
	assert.equal(noGoal.ok, false);
	if (!noGoal.ok) assert.match(noGoal.message, /No goal is set/);

	const stale = validateGoalCompletion({ goal: goal({ id: "current" }), runningGoalId: "old" });
	assert.equal(stale.ok, false);
	if (!stale.ok) assert.match(stale.message, /changed during this run/);

	const paused = validateGoalCompletion({ goal: goal({ status: "paused", autoContinue: false }) });
	assert.equal(paused.ok, false);
	if (!paused.ok) assert.match(paused.message, /ask the user to resume/);

	assert.deepEqual(validateGoalCompletion({ goal: sisyphus() }), { ok: true });
});

test("pause, resume, and clear policy preserve human-owned lifecycle affordances", () => {
	assert.match(rejectedMessage(validatePauseGoal({ goal: null, reason: "blocked" })), /no-op/);
	assert.match(rejectedMessage(validatePauseGoal({ goal: goal({ id: "new" }), runningGoalId: "old", reason: "blocked" })), /changed during this run/);
	assert.match(rejectedMessage(validatePauseGoal({ goal: goal({ status: "complete" }), reason: "blocked" })), /does not apply/);
	assert.deepEqual(validatePauseGoal({ goal: goal(), reason: "blocked" }), { ok: true });

	const paused = buildPausedByAgentGoal(goal(), {
		reason: "Need credentials",
		suggestedAction: "Set TOKEN and /goal-resume",
		updatedAt: "2026-05-12T01:00:00.000Z",
	});
	assert.equal(paused.status, "paused");
	assert.equal(paused.autoContinue, false);
	assert.equal(paused.stopReason, "agent");
	assert.equal(paused.pauseReason, "Need credentials");
	assert.equal(paused.pauseSuggestedAction, "Set TOKEN and /goal-resume");

	assert.match(rejectedMessage(validateResumeGoal(null)), /No goal is set/);
	assert.match(rejectedMessage(validateResumeGoal(goal({ status: "complete" }))), /Goal is complete/);
	assert.match(rejectedMessage(validateResumeGoal(goal({ status: "active", autoContinue: true }))), /already running/);
	assert.match(rejectedMessage(validateResumeGoal(goal({ status: "budgetLimited", tokenBudget: 10, usage: { tokensUsed: 10, activeSeconds: 0 } }))), /budget-limited/);
	assert.deepEqual(validateResumeGoal(goal({ status: "paused", autoContinue: false })), { ok: true });

	assert.equal(clearGoalCommandMessage({ archived: true, wasDrafting: false }), "Goal cleared and archived.");
	assert.equal(clearGoalCommandMessage({ archived: false, wasDrafting: true }), "Drafting cancelled.");
	assert.equal(clearGoalCommandMessage({ archived: false, wasDrafting: false }), "No goal is set.");

	assert.equal(
		buildCompletionReport({ detailedSummary: "Goal: full objective\nStatus: complete", completionSummary: "All requested checks passed." }),
		"Goal complete.\n\nCompletion summary:\nAll requested checks passed.\n\nGoal: full objective\nStatus: complete",
	);
	assert.equal(
		buildCompletionReport({ detailedSummary: "Goal: full objective", completionSummary: "   " }),
		"Goal complete.\n\nGoal: full objective",
	);
	assert.equal(
		buildGoalCreatedReport({ objective: "# Objective\nShip the feature.", detailedSummary: "Status: active" }),
		"Goal confirmed and created.\n\nFinalized goal:\n\n# Objective\nShip the feature.\n\nGoal details:\nStatus: active",
	);
});

test("budget, autoContinue cap, and compaction policies are deterministic", () => {
	assert.equal(statusAfterBudgetLimit(goal({ tokenBudget: 10, usage: { tokensUsed: 9, activeSeconds: 0 } })), "active");
	assert.equal(statusAfterBudgetLimit(goal({ tokenBudget: 10, usage: { tokensUsed: 10, activeSeconds: 0 } })), "budgetLimited");
	assert.equal(statusAfterBudgetLimit(goal({ status: "paused", tokenBudget: 10, usage: { tokensUsed: 20, activeSeconds: 0 } })), "paused");

	assert.equal(shouldQueueContinuation(goal({ status: "active", autoContinue: true })), true);
	assert.equal(shouldQueueContinuation(goal({ status: "paused", autoContinue: true })), false);
	assert.equal(shouldAutoPauseForContinueCap({ goal: goal(), autoContinueTurns: 29, maxTurns: 30 }), false);
	assert.equal(shouldAutoPauseForContinueCap({ goal: goal(), autoContinueTurns: 30, maxTurns: 30 }), true);
	assert.equal(shouldAutoPauseForContinueCap({ goal: goal({ autoContinue: false }), autoContinueTurns: 30, maxTurns: 30 }), false);

	const capped = buildAutoContinueCapPause(goal(), { maxTurns: 3, updatedAt: "2026-05-12T02:00:00.000Z" });
	assert.equal(capped.status, "paused");
	assert.equal(capped.autoContinue, false);
	assert.equal(capped.pauseReason, "Auto-continue cap reached (3 consecutive turns).");
	assert.match(capped.pauseSuggestedAction ?? "", /goal-resume/);

	assert.equal(shouldArmPostCompactReminder(sisyphus({ status: "active" })), true);
	assert.equal(shouldArmPostCompactReminder(goal({ status: "budgetLimited", sisyphus: false })), true);
	assert.equal(shouldArmPostCompactReminder(sisyphus({ status: "paused", autoContinue: false })), false);
	assert.equal(shouldInjectPostCompactReminder({ pending: true, goal: sisyphus() }), true);
	assert.equal(shouldInjectPostCompactReminder({ pending: true, goal: goal({ sisyphus: false }) }), true);
	assert.equal(shouldInjectPostCompactReminder({ pending: false, goal: sisyphus() }), false);
});
