import assert from "node:assert/strict";
import test from "node:test";

import {
	displayObjectiveTitle,
	footerStatus,
	formatDuration,
	formatRemainingTokens,
	formatTokenBudget,
	formatTokenValue,
	isQuestionLikeToolName,
	parseTokenBudgetFromTopic,
	statusLabel,
	truncateText,
	type GoalDisplayRecordLike,
} from "../extensions/goal-core.ts";

test("parseTokenBudgetFromTopic extracts user-provided token budgets", () => {
	assert.equal(parseTokenBudgetFromTopic("please use 5000 tokens max"), 5000);
	assert.equal(parseTokenBudgetFromTopic("token budget 10000"), 10000);
	assert.equal(parseTokenBudgetFromTopic("10000 token budget"), 10000);
	assert.equal(parseTokenBudgetFromTopic("预算 20000"), 20000);
	assert.equal(parseTokenBudgetFromTopic("20000 预算"), 20000);
	assert.equal(parseTokenBudgetFromTopic("small 99 tokens"), null);
});

test("displayObjectiveTitle strips goal block boilerplate", () => {
	assert.equal(
		displayObjectiveTitle("=== Goal ===\nObjective: Build tests first\nSuccess criteria: pass"),
		"Build tests first",
	);
	assert.equal(
		displayObjectiveTitle("=== Sisyphus Goal ===\n目标：严格执行三步\nSteps:\n1. x"),
		"严格执行三步",
	);
	assert.equal(displayObjectiveTitle("Just a plain objective"), "Just a plain objective");
});

test("formatters preserve existing compact duration/token/status behavior", () => {
	assert.equal(formatDuration(-10), "0s");
	assert.equal(formatDuration(65), "1m05s");
	assert.equal(formatDuration(3661), "1h01m01s");
	assert.equal(formatTokenValue(999), "999 tokens");
	assert.equal(formatTokenValue(1200), "1.2K (1,200) tokens");
	assert.equal(formatTokenValue(12000), "12K (12,000) tokens");
	assert.equal(formatTokenValue(2_500_000), "2.5M (2,500,000) tokens");
	assert.equal(truncateText(" a\n b\t c ", 20), "a b c");
	assert.equal(truncateText("abcdefghij", 8), "abcde...");
});

test("goal display helpers derive labels, budget, remaining, and footer", () => {
	const goal: GoalDisplayRecordLike = {
		objective: "=== Goal ===\nObjective: Build test scaffolding and split helpers",
		status: "active",
		autoContinue: true,
		tokenBudget: 20_000,
		usage: { activeSeconds: 125, tokensUsed: 4_500 },
		sisyphus: false,
	};
	assert.equal(statusLabel(goal), "running");
	assert.equal(formatTokenBudget(goal), "20K (20,000) tokens");
	assert.equal(formatRemainingTokens(goal), "16K (15,500) tokens");
	assert.match(footerStatus(goal), /^goal: running \[2m05s 4.5K \/ 20K\] - === Goal === Objective:/);

	assert.equal(statusLabel({ ...goal, sisyphus: true }), "sisyphus running");
	assert.equal(statusLabel({ ...goal, status: "paused", stopReason: "agent" }), "paused (agent)");
	assert.equal(statusLabel({ ...goal, status: "budgetLimited" }), "budget_limited");
});

test("isQuestionLikeToolName allows dialogue tools but not workhorse tools", () => {
	for (const name of ["goal_question", "goal_questionnaire", "question", "questionnaire", "ask_user", "clarify_scope", "confirm_choice"]) {
		assert.equal(isQuestionLikeToolName(name), true, name);
	}
	for (const name of ["bash", "read", "grep", "write", "edit", "step_complete", "pause_goal"]) {
		assert.equal(isQuestionLikeToolName(name), false, name);
	}
});
