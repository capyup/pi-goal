import assert from "node:assert/strict";
import test from "node:test";

import {
	ABORT_GOAL_TOOL_NAME,
	ACTIVE_GOAL_TOOL_NAMES,
	CREATE_GOAL_TOOL_NAME,
	GOAL_WORK_TOOL_NAMES,
	GOAL_PROGRESS_TOOL_NAMES,
	NO_FOCUSED_GOAL_TOOL_NAMES,
	PAUSED_GOAL_TOOL_NAMES,
	POST_STOP_ALLOWED_TOOLS,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	TWEAK_APPLY_TOOL_NAME,
	isQuestionLikeToolName,
	lifecycleToolNamesForGoalStatus,
} from "../extensions/goal-tool-names.ts";

test("goal tool names are centralized and preserve published agent-facing names", () => {
	assert.equal(QUESTION_TOOL_NAME, "goal_question");
	assert.equal(QUESTIONNAIRE_TOOL_NAME, "goal_questionnaire");
	assert.equal(PROPOSE_DRAFT_TOOL_NAME, "propose_goal_draft");
	assert.equal(TWEAK_APPLY_TOOL_NAME, "apply_goal_tweak");
	assert.equal(SISYPHUS_STEP_TOOL_NAME, "step_complete");
	assert.equal(CREATE_GOAL_TOOL_NAME, "create_goal");
	assert.equal(ABORT_GOAL_TOOL_NAME, "abort_goal");
	assert.deepEqual(ACTIVE_GOAL_TOOL_NAMES, ["get_goal", "update_goal", "pause_goal", "abort_goal"]);
	assert.deepEqual(PAUSED_GOAL_TOOL_NAMES, ["get_goal", "update_goal", "abort_goal"]);
	assert.deepEqual(NO_FOCUSED_GOAL_TOOL_NAMES, ["get_goal"]);
	assert.deepEqual(POST_STOP_ALLOWED_TOOLS, ["get_goal"]);
});

test("lifecycle tool visibility keeps no-focus read-only and focused mutations scoped", () => {
	assert.deepEqual(lifecycleToolNamesForGoalStatus(null), ["get_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("active", "drafting"), ["get_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("paused", "tweakDrafting"), ["get_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("complete"), ["get_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("active"), ["get_goal", "update_goal", "pause_goal", "abort_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("budgetLimited"), ["get_goal", "update_goal", "pause_goal", "abort_goal"]);
	assert.deepEqual(lifecycleToolNamesForGoalStatus("paused"), ["get_goal", "update_goal", "abort_goal"]);
});

test("progress tool set excludes read-only and drafting dialogue tools", () => {
	for (const toolName of ["get_goal", QUESTION_TOOL_NAME, QUESTIONNAIRE_TOOL_NAME, PROPOSE_DRAFT_TOOL_NAME, CREATE_GOAL_TOOL_NAME]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(toolName as typeof GOAL_PROGRESS_TOOL_NAMES[number]), false, toolName);
	}
	for (const toolName of ["bash", "read", "write", "update_goal", "pause_goal", ABORT_GOAL_TOOL_NAME, TWEAK_APPLY_TOOL_NAME]) {
		assert.equal(GOAL_PROGRESS_TOOL_NAMES.includes(toolName as typeof GOAL_PROGRESS_TOOL_NAMES[number]), true, toolName);
	}
});

test("goal work tool set keeps lifecycle and workhorse tools visible to continuation gating", () => {
	for (const toolName of [
		TWEAK_APPLY_TOOL_NAME,
		CREATE_GOAL_TOOL_NAME,
		PROPOSE_DRAFT_TOOL_NAME,
		ABORT_GOAL_TOOL_NAME,
		QUESTION_TOOL_NAME,
		QUESTIONNAIRE_TOOL_NAME,
		"get_goal",
		"bash",
		"write",
	]) {
		assert.equal(GOAL_WORK_TOOL_NAMES.includes(toolName as typeof GOAL_WORK_TOOL_NAMES[number]), true);
	}
	assert.equal(GOAL_WORK_TOOL_NAMES.includes(SISYPHUS_STEP_TOOL_NAME as typeof GOAL_WORK_TOOL_NAMES[number]), false);
});

test("isQuestionLikeToolName allows dialogue tools but not workhorse tools", () => {
	for (const name of [QUESTION_TOOL_NAME, QUESTIONNAIRE_TOOL_NAME, "question", "questionnaire", "ask_user", "clarify_scope", "confirm_choice"]) {
		assert.equal(isQuestionLikeToolName(name), true, name);
	}
	for (const name of ["bash", "read", "write", "edit", "grep", "find", "ls", "step_complete", "pause_goal", "abort_goal"]) {
		assert.equal(isQuestionLikeToolName(name), false, name);
	}
});
