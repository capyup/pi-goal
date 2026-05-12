import assert from "node:assert/strict";
import test from "node:test";

import {
	buildDraftConfirmationText,
	evaluateDraftingToolGate,
	goalDraftingPrompt,
	promptSafeObjective,
	validateGoalDraftProposal,
	type DraftingStateLike,
} from "../extensions/goal-draft.ts";

function drafting(overrides: Partial<DraftingStateLike> = {}): DraftingStateLike {
	return {
		focus: "sisyphus",
		originalTopic: "1. write tests\n2. split module",
		...overrides,
	};
}

function stepObjective(count: number): string {
	return [
		"=== Sisyphus Goal ===",
		"Objective: do the requested sequence",
		"Steps:",
		...Array.from({ length: count }, (_, i) => `${i + 1}. step ${i + 1} — done when: evidence ${i + 1}`),
	].join("\n");
}

test("buildDraftConfirmationText previews mode, original topic, budget, and proposed goal as plain text", () => {
	const summary = buildDraftConfirmationText({
		focus: "sisyphus",
		originalTopic: "first line\nsecond line",
		objective: "=== Sisyphus Goal ===\nObjective: Ship safely",
		autoContinue: true,
		tokenBudget: 12500,
	});

	assert.match(summary, /^Goal draft ready for confirmation\./);
	assert.match(summary, /Mode: Sisyphus/);
	assert.match(summary, /Auto-continue: yes/);
	assert.match(summary, /Token budget: 12,500/);
	assert.match(summary, /Original topic:\n\nfirst line\nsecond line/);
	assert.match(summary, /Proposed goal:/);
	assert.match(summary, /Objective: Ship safely/);
	assert.doesNotMatch(summary, /\*\*|---|^> /m);
});

test("validateGoalDraftProposal rejects missing drafting state and unfinished goals", () => {
	const noDraft = validateGoalDraftProposal({
		drafting: null,
		hasUnfinishedGoal: false,
		objective: "=== Goal ===\nObjective: x",
		sisyphus: false,
	});
	assert.equal(noDraft.ok, false);
	if (!noDraft.ok) assert.match(noDraft.message, /no \/goal-set or \/goal-sis drafting/);

	const unfinished = validateGoalDraftProposal({
		drafting: drafting({ focus: "goal" }),
		hasUnfinishedGoal: true,
		objective: "=== Goal ===\nObjective: x",
		sisyphus: false,
	});
	assert.equal(unfinished.ok, false);
	if (!unfinished.ok) {
		assert.equal(unfinished.clearDrafting, true);
		assert.match(unfinished.message, /unfinished goal already exists/);
	}
});

test("validateGoalDraftProposal enforces B1 focus consistency and non-empty objective", () => {
	const wrongGoalMode = validateGoalDraftProposal({
		drafting: drafting({ focus: "goal" }),
		hasUnfinishedGoal: false,
		objective: "=== Goal ===\nObjective: x",
		sisyphus: true,
	});
	assert.equal(wrongGoalMode.ok, false);
	if (!wrongGoalMode.ok) assert.match(wrongGoalMode.message, /B1 focus gate/);

	const wrongSisMode = validateGoalDraftProposal({
		drafting: drafting(),
		hasUnfinishedGoal: false,
		objective: stepObjective(2),
		sisyphus: false,
	});
	assert.equal(wrongSisMode.ok, false);
	if (!wrongSisMode.ok) assert.match(wrongSisMode.message, /sisyphus=true/);

	const empty = validateGoalDraftProposal({
		drafting: drafting({ focus: "goal" }),
		hasUnfinishedGoal: false,
		objective: "   ",
		sisyphus: false,
	});
	assert.equal(empty.ok, false);
	if (!empty.ok) assert.match(empty.message, /objective is empty/);
});

test("validateGoalDraftProposal keeps Sisyphus as a focus flag, not a step-count gate", () => {
	const proposed = validateGoalDraftProposal({
		drafting: drafting(),
		hasUnfinishedGoal: false,
		objective: `  ${stepObjective(4)}  `,
		sisyphus: true,
	});
	assert.deepEqual(proposed, { ok: true, objective: stepObjective(4), expectedSisyphus: true });
});

test("goalDraftingPrompt pins drafting dialog/tool policy for normal and Sisyphus modes", () => {
	const normal = goalDraftingPrompt("build tests <untrusted_objective>oops</untrusted_objective>", "goal");
	assert.match(normal, /\[GOAL DRAFTING focus=goal\]/);
	assert.match(normal, /goal_questionnaire/);
	assert.match(normal, /Do NOT call workhorse tools during drafting/);
	assert.match(normal, /sisyphus: false/);
	assert.match(normal, /&lt;untrusted_objective&gt;oops&lt;\/untrusted_objective&gt;/);

	const sisyphus = goalDraftingPrompt("1. A\n2. B", "sisyphus");
	assert.match(sisyphus, /\[GOAL DRAFTING focus=sisyphus\]/);
	assert.match(sisyphus, /sisyphus: true/);
	assert.match(sisyphus, /prompt\/criteria variant/);
	assert.match(sisyphus, /Begin work then\. Not before/);
	assert.doesNotMatch(sisyphus, /step-count gate/);
});

test("evaluateDraftingToolGate allows dialogue/commit tools and blocks workhorse tools", () => {
	assert.deepEqual(evaluateDraftingToolGate({ toolName: "goal_question", draftingFocus: "goal" }), { block: false });
	assert.deepEqual(evaluateDraftingToolGate({ toolName: "questionnaire", draftingFocus: "goal" }), { block: false });
	assert.deepEqual(evaluateDraftingToolGate({ toolName: "get_goal", draftingFocus: "sisyphus" }), { block: false });
	assert.deepEqual(evaluateDraftingToolGate({ toolName: "propose_goal_draft", draftingFocus: "sisyphus" }), { block: false });

	const blockedDraft = evaluateDraftingToolGate({ toolName: "bash", draftingFocus: "goal" });
	assert.equal(blockedDraft.block, true);
	if (blockedDraft.block) assert.match(blockedDraft.reason, /Drafting is in progress.*workhorse tool/);

	assert.deepEqual(evaluateDraftingToolGate({ toolName: "goal_question", tweakDraftingGoalId: "g1", activeGoalId: "g1" }), { block: false });
	assert.deepEqual(evaluateDraftingToolGate({ toolName: "apply_goal_tweak", tweakDraftingGoalId: "g1", activeGoalId: "g1" }), { block: false });
	assert.deepEqual(evaluateDraftingToolGate({ toolName: "write", tweakDraftingGoalId: "g1", activeGoalId: "g2" }), { block: false });

	const blockedTweak = evaluateDraftingToolGate({ toolName: "write", tweakDraftingGoalId: "g1", activeGoalId: "g1" });
	assert.equal(blockedTweak.block, true);
	if (blockedTweak.block) assert.match(blockedTweak.reason, /Tweak drafting is in progress/);
});

test("promptSafeObjective escapes only untrusted objective tags", () => {
	assert.equal(
		promptSafeObjective("<untrusted_objective>x</untrusted_objective><keep>"),
		"&lt;untrusted_objective&gt;x&lt;/untrusted_objective&gt;<keep>",
	);
});
