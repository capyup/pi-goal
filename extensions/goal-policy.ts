import { statusLabel, type GoalDisplayRecordLike } from "./goal-core.ts";

export type GoalStatusLike = "active" | "paused" | "budgetLimited" | "complete";
export type StopReasonLike = "user" | "agent";

export interface GoalPolicyRecordLike extends GoalDisplayRecordLike {
	id: string;
	status: GoalStatusLike;
	updatedAt?: string;
	pauseReason?: string;
	pauseSuggestedAction?: string;
}

export type PolicyValidation =
	| { ok: true }
	| { ok: false; message: string };

export function isGoalUnfinished(goal: Pick<GoalPolicyRecordLike, "status"> | null | undefined): boolean {
	return !!goal && goal.status !== "complete";
}

export function isRunnableStatus(status: GoalStatusLike): boolean {
	return status === "active" || status === "budgetLimited";
}

export function statusAfterBudgetLimit(goal: Pick<GoalPolicyRecordLike, "status" | "tokenBudget" | "usage">): GoalStatusLike {
	if (goal.status === "active" && goal.tokenBudget !== null && goal.usage.tokensUsed >= goal.tokenBudget) {
		return "budgetLimited";
	}
	return goal.status;
}

export function validateGoalCreationSlot(goal: Pick<GoalPolicyRecordLike, "status"> | null): PolicyValidation {
	if (isGoalUnfinished(goal)) return { ok: false, message: "An unfinished goal already exists. Ask the user before replacing it." };
	return { ok: true };
}

export function validateGoalCompletion(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
}): PolicyValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not marking it complete." };
	if (!isRunnableStatus(goal.status)) return { ok: false, message: `Goal is ${statusLabel(goal)}; ask the user to resume it before marking complete.` };
	return { ok: true };
}

export function validatePauseGoal(args: {
	goal: GoalPolicyRecordLike | null;
	runningGoalId?: string | null;
	reason: string;
}): PolicyValidation {
	const { goal, runningGoalId } = args;
	if (!goal) return { ok: false, message: "No goal is set; pause_goal is a no-op." };
	if (runningGoalId && goal.id !== runningGoalId) return { ok: false, message: "The active goal changed during this run; not pausing." };
	if (!isRunnableStatus(goal.status)) return { ok: false, message: `Goal is ${statusLabel(goal)}; pause_goal does not apply.` };
	if (!args.reason.trim()) return { ok: false, message: "pause_goal requires a non-empty reason." };
	return { ok: true };
}

export function buildPausedByAgentGoal<T extends GoalPolicyRecordLike>(goal: T, args: {
	reason: string;
	suggestedAction?: string;
	updatedAt: string;
}): T {
	const suggested = args.suggestedAction?.trim() || undefined;
	return {
		...goal,
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: args.reason.trim(),
		pauseSuggestedAction: suggested,
		updatedAt: args.updatedAt,
	};
}

export function validateResumeGoal(goal: GoalPolicyRecordLike | null): PolicyValidation {
	if (!goal) return { ok: false, message: "No goal is set. Use /goal-set or /goal-sis to start one." };
	if (goal.status === "complete") return { ok: false, message: "Goal is complete. Use /goal-set to start a new one." };
	if (goal.status === "active" && goal.autoContinue) return { ok: false, message: "Goal is already running." };
	if (goal.status === "budgetLimited" && goal.tokenBudget !== null && goal.usage.tokensUsed >= goal.tokenBudget) {
		return { ok: false, message: "Goal is budget-limited. Raise or remove the budget before resuming." };
	}
	return { ok: true };
}

export function clearGoalCommandMessage(args: { archived: boolean; wasDrafting: boolean }): string {
	return args.archived ? "Goal cleared and archived." : args.wasDrafting ? "Drafting cancelled." : "No goal is set.";
}

export function buildCompletionReport(args: { detailedSummary: string; completionSummary?: string | null }): string {
	const lines = ["Goal complete."];
	const summary = args.completionSummary?.trim();
	if (summary) {
		lines.push("", "Completion summary:", summary);
	}
	lines.push("", args.detailedSummary);
	return lines.join("\n");
}

export function buildGoalCreatedReport(args: { objective: string; detailedSummary?: string | null }): string {
	const lines = ["Goal confirmed and created.", "", "Finalized goal:", "", args.objective.trim()];
	const summary = args.detailedSummary?.trim();
	if (summary) {
		lines.push("", "Goal details:", summary);
	}
	return lines.join("\n");
}

export function shouldQueueContinuation(goal: Pick<GoalPolicyRecordLike, "status" | "autoContinue"> | null): boolean {
	return !!goal && goal.status === "active" && goal.autoContinue;
}

export function shouldAutoPauseForContinueCap(args: {
	goal: Pick<GoalPolicyRecordLike, "id" | "status" | "autoContinue"> | null;
	autoContinueTurns: number;
	maxTurns: number;
}): boolean {
	return shouldQueueContinuation(args.goal) && args.autoContinueTurns >= args.maxTurns;
}

export function buildAutoContinueCapPause<T extends GoalPolicyRecordLike>(goal: T, args: { maxTurns: number; updatedAt: string }): T {
	return {
		...goal,
		status: "paused",
		autoContinue: false,
		stopReason: "agent",
		pauseReason: `Auto-continue cap reached (${args.maxTurns} consecutive turns).`,
		pauseSuggestedAction: "Review the goal's progress and /goal-resume, /goal-tweak, or /goal-clear.",
		updatedAt: args.updatedAt,
	};
}

export function shouldArmPostCompactReminder(goal: Pick<GoalPolicyRecordLike, "sisyphus" | "status"> | null): boolean {
	return !!goal && isRunnableStatus(goal.status);
}

export function shouldInjectPostCompactReminder(args: { pending: boolean; goal: Pick<GoalPolicyRecordLike, "sisyphus"> | null }): boolean {
	return args.pending && !!args.goal;
}
