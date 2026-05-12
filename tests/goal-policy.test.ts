import assert from "node:assert/strict";
import test from "node:test";

import {
	abortGoalCommandMessage,
	applyGoalBudgetUpdate,
	buildAbortedByAgentGoal,
	buildAutoContinueCapPause,
	buildCompletionReport,
	buildGoalCreatedReport,
	buildPausedByAgentGoal,
	clearGoalCommandMessage,
	isGoalUnfinished,
	parseGoalBudgetUpdate,
	shouldArmPostCompactReminder,
	shouldAutoPauseForContinueCap,
	shouldInjectPostCompactReminder,
	shouldQueueContinuation,
	statusAfterBudgetLimit,
	validateGoalAbort,
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
	assert.deepEqual(validateGoalCreationSlot(goal({ status: "paused" })), { ok: true });

	assert.deepEqual(validateGoalCompletion({ goal: goal({ sisyphus: false }) }), { ok: true });
	const noGoal = validateGoalCompletion({ goal: null });
	assert.equal(noGoal.ok, false);
	if (!noGoal.ok) assert.match(noGoal.message, /No goal is set/);

	const stale = validateGoalCompletion({ goal: goal({ id: "current" }), runningGoalId: "old" });
	assert.equal(stale.ok, false);
	if (!stale.ok) assert.match(stale.message, /changed during this run/);

	assert.deepEqual(validateGoalCompletion({ goal: goal({ status: "paused", autoContinue: false }) }), { ok: true });
	assert.match(rejectedMessage(validateGoalCompletion({ goal: goal({ status: "complete", autoContinue: false }) })), /complete/);

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

test("abort policy supports agent-owned abandonment without a new lifecycle state", () => {
	assert.match(rejectedMessage(validateGoalAbort({ goal: null, reason: "obsolete" })), /no-op/);
	assert.match(rejectedMessage(validateGoalAbort({ goal: goal({ id: "new" }), runningGoalId: "old", reason: "obsolete" })), /changed during this run/);
	assert.match(rejectedMessage(validateGoalAbort({ goal: goal({ status: "complete" }), reason: "obsolete" })), /does not apply/);
	assert.match(rejectedMessage(validateGoalAbort({ goal: goal(), reason: "   " })), /requires a non-empty reason/);
	assert.deepEqual(validateGoalAbort({ goal: goal({ status: "paused", autoContinue: false }), reason: "Obsolete objective" }), { ok: true });
	assert.deepEqual(validateGoalAbort({ goal: goal({ status: "budgetLimited" }), reason: "Obsolete objective" }), { ok: true });

	const aborted = buildAbortedByAgentGoal(goal(), {
		reason: "User replaced the work with a different request",
		updatedAt: "2026-05-12T03:00:00.000Z",
	});
	assert.equal(aborted.status, "paused");
	assert.equal(aborted.autoContinue, false);
	assert.equal(aborted.stopReason, "agent");
	assert.equal(aborted.pauseReason, "Aborted: User replaced the work with a different request");
	assert.equal(aborted.pauseSuggestedAction, undefined);

	assert.equal(abortGoalCommandMessage({ archived: true, wasDrafting: false }), "Goal aborted and archived.");
	assert.equal(abortGoalCommandMessage({ archived: false, wasDrafting: true }), "Drafting cancelled.");
	assert.equal(abortGoalCommandMessage({ archived: false, wasDrafting: false }), "No goal is set.");
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

test("budget updates parse safely and reactivate budget-limited goals", () => {
	assert.deepEqual(parseGoalBudgetUpdate("none"), { ok: true, tokenBudget: null, label: "none" });
	assert.deepEqual(parseGoalBudgetUpdate("25k"), { ok: true, tokenBudget: 25_000, label: "25,000" });
	assert.equal(parseGoalBudgetUpdate("abc").ok, false);

	const updated = applyGoalBudgetUpdate(goal({
		status: "budgetLimited",
		autoContinue: false,
		tokenBudget: 100,
		usage: { tokensUsed: 100, activeSeconds: 0 },
	}), { tokenBudget: 200, updatedAt: "2026-05-12T04:00:00.000Z" });
	assert.equal(updated.status, "active");
	assert.equal(updated.autoContinue, true);
	assert.equal(updated.tokenBudget, 200);
	assert.equal(updated.updatedAt, "2026-05-12T04:00:00.000Z");

	const stillLimited = applyGoalBudgetUpdate(goal({
		status: "budgetLimited",
		autoContinue: false,
		tokenBudget: 100,
		usage: { tokensUsed: 250, activeSeconds: 0 },
	}), { tokenBudget: 200, updatedAt: "2026-05-12T04:00:00.000Z" });
	assert.equal(stillLimited.status, "budgetLimited");
});
