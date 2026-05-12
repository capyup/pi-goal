import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, visibleWidth } from "@earendil-works/pi-tui";
import {
	footerStatus,
	formatDuration,
	formatRemainingTokens,
	formatTokenBudget,
	formatTokenValue,
	parseTokenBudgetFromTopic,
	statusLabel,
	truncateText,
} from "./goal-core.ts";
import {
	buildDraftConfirmationText,
	evaluateDraftingToolGate,
	goalDraftingPrompt,
	validateDraftPromptIdentity,
	validateGoalDraftProposal,
	type GoalDraftingFocus,
} from "./goal-draft.ts";
import {
	isHeadlessQuestionSufficientForDraft,
	proposalDialogFailureMessage,
	registerQuestionnaireTools,
	shouldAutoConfirmProposal,
	showProposalDialog,
} from "./goal-questionnaire.ts";
import {
	ABORT_GOAL_TOOL_NAME,
	ACTIVE_GOAL_TOOL_NAMES,
	CREATE_GOAL_TOOL_NAME,
	POST_STOP_ALLOWED_TOOLS,
	PROPOSE_DRAFT_TOOL_NAME,
	QUESTIONNAIRE_TOOL_NAME,
	QUESTION_TOOL_NAME,
	SISYPHUS_STEP_TOOL_NAME,
	GOAL_PROGRESS_TOOL_NAMES,
	lifecycleToolNamesForGoalStatus,
	TWEAK_APPLY_TOOL_NAME,
	isQuestionLikeToolName,
} from "./goal-tool-names.ts";
import {
	asRecord,
	cloneGoal,
	createGoal,
	goalFocusDetails,
	normalizeGoalRecord,
	normalizeGoalFocusEntry,
	nowIso,
	type AssistantMessageLike,
	type DraftingFocus,
	type GoalFocusEntry,
	type GoalFocusReason,
	type GoalCreationConfig,
	type GoalEventDetails,
	type GoalEventKind,
	type GoalRecord,
	type GoalStateEntry,
	type GoalStatus,
	type StopReason,
} from "./goal-record.ts";
import {
	archiveGoalFile,
	mergeGoalPromptFromDisk,
	readActiveGoalPool,
	sanitizeGoalPaths,
	writeActiveGoalFile,
} from "./storage/goal-files.ts";
import {
	buildGoalListText,
	buildUnfocusedOpenGoalsSummary,
	focusedGoalFromPool,
	goalSelectorLabel,
	mergeFocusedGoalWithDisk,
	openGoalsFromPool,
	otherOpenGoalCount,
	resolveSessionFocus,
} from "./goal-pool.ts";
import {
	budgetBlock,
	budgetLimitPrompt,
	continuationPrompt,
	goalPrompt,
	goalTweakDraftingPrompt,
	staleContinuationPrompt,
	unfocusedOpenGoalsPrompt,
	untrustedObjectiveBlock,
} from "./prompts/goal-prompts.ts";
import { buildGoalRunningNotification } from "./widgets/goal-notifications.ts";
import { GoalWidgetComponent } from "./widgets/goal-widget.ts";

import {
	abortGoalCommandMessage,
	applyGoalBudgetUpdate,
	buildAbortedByAgentGoal,
	buildAutoContinueCapPause,
	buildCompletionReport,
	buildGoalCreatedReport,
	buildPausedByAgentGoal,
	clearGoalCommandMessage,
	parseGoalBudgetUpdate,
	shouldArmPostCompactReminder,
	shouldAutoPauseForContinueCap,
	shouldInjectPostCompactReminder,
	statusAfterBudgetLimit,
	validateGoalAbort,
	validateGoalCompletion,
	validatePauseGoal,
	validateResumeGoal,
} from "./goal-policy.ts";

const STATE_ENTRY = "pi-goal-state";
const FOCUS_ENTRY = "pi-goal-focus";
const GOAL_EVENT_ENTRY = "pi-goal-event";
const COMPLETE_STATUS = "complete";
const CONTINUATION_IDLE_RETRY_MS = 50;
const STATUS_REFRESH_MS = 1000;
/**
 * Hard cap on consecutive autoContinue turns per active goal. Borrowed from
 * pi-autoresearch's MAX_AUTORESUME_TURNS pattern: prevents runaway chains when
 * the model gets stuck in chat-only loops. Reset on new goal, user input, or
 * goal clear/pause. When hit, the goal is auto-paused with a clear notice.
 */
const MAX_AUTOCONTINUE_TURNS = (() => {
	const raw = process.env.PI_GOAL_MAX_AUTOCONTINUE_TURNS;
	if (!raw) return 30;
	const parsed = Number.parseInt(raw, 10);
	if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 1000) return parsed;
	return 30;
})();

/**
 * Tools that count as "real work" toward the active goal. If a non-tool-use
 * turn ends without any of these having been called, we DO NOT queue the next
 * autoContinue — the agent was just chatting. This stops infinite chat loops.
 */
const GOAL_PROGRESS_TOOL_SET = new Set<string>(GOAL_PROGRESS_TOOL_NAMES);


/**
 * Tools that are NEVER blocked by the post-stop in-turn block. After pause_goal,
 * abort_goal, update_goal=complete, or apply_goal_tweak fires, the agent should
 * yield the turn; we block all subsequent tool calls except these read-only inspections.
 */
const POST_STOP_ALLOWED_TOOL_SET = new Set<string>(POST_STOP_ALLOWED_TOOLS);

/**
 * When non-null, /goal-tweak drafting is in progress for this goal id and the
 * agent is allowed to call apply_goal_tweak. Cleared after the tweak is applied
 * or when a user-driven turn arrives without a tweak follow-through. This is
 * the schema-level affordance gate that prevents the agent from "tweaking" via
 * arbitrary write/edit calls.
 */
let tweakDraftingFor: string | null = null;

/**
 * Phase 5 D + B1: when non-null, a /goal-set or /goal-sisyphus drafting flow
 * is in progress. During that window:
 *   - propose_goal_draft tool is the ONLY way to commit the goal (UI confirm)
 *   - create_goal tool is hidden from the agent
 *   - schema gate B1 (focus consistency) fires
 *     when the agent calls propose_goal_draft
 *
 * Cleared after goal is created (confirmed) or the user replaces/clears it.
 */
interface DraftingState {
	focus: GoalDraftingFocus;
	originalTopic: string;       // user's exact input to /goal-set or /goal-sisyphus
	draftId: string;
	startedAt: number;
	questionsAsked: number;
}
let draftingFor: DraftingState | null = null;
const draftingNudgesByDraftId = new Map<string, number>();

/**
 * Parsed token budget from the user's initial topic, to be injected automatically
 * into the next create_goal call. The agent never sees tokenBudget as a writable
 * tool parameter; only the user can specify it (conversationally in the topic,
 * or later via /goal-tweak). Cleared after consumption.
 */
let pendingBudget: number | null = null;


// ---------- summaries ----------

function usageLines(goal: GoalRecord): string[] {
	const lines = [
		`Time spent: ${formatDuration(goal.usage.activeSeconds)}`,
		`Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}`,
		`Token budget: ${formatTokenBudget(goal)}`,
	];
	if (goal.tokenBudget !== null) lines.push(`Tokens remaining: ${formatRemainingTokens(goal)}`);
	return lines;
}

function detailedSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set. Use /goal-set <topic> (normal drafting) or /goal-sisyphus <topic> (Sisyphus drafting).";
	const lines = [
		`Goal: ${goal.objective}`,
		`Status: ${statusLabel(goal)}`,
		`Auto-continue: ${goal.autoContinue ? "on" : "off"}`,
		...usageLines(goal),
	];
	if (goal.sisyphus) {
		lines.push("Mode: Sisyphus (prompt/criteria variant; shared goal lifecycle)");
	}
	if (goal.activePath) lines.push(`File: ${goal.activePath}`);
	if (goal.archivedPath) lines.push(`Archive: ${goal.archivedPath}`);
	if (goal.stopReason) lines.push(`Stop reason: ${goal.stopReason}`);
	if (goal.pauseReason) lines.push(`Agent pause reason: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction) lines.push(`Agent suggests: ${goal.pauseSuggestedAction}`);
	return lines.join("\n");
}

function oneLineSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set.";
	const tail =
		goal.tokenBudget !== null
			? ` [${formatTokenValue(goal.usage.tokensUsed).split(" ")[0]} / ${formatTokenValue(goal.tokenBudget).split(" ")[0]}]`
			: goal.usage.tokensUsed > 0
				? ` [${formatTokenValue(goal.usage.tokensUsed).split(" ")[0]}]`
				: "";
	return `${statusLabel(goal)}${tail} - ${truncateText(goal.objective)}`;
}

// ---------- entry / render helpers ----------

function goalDetails(goal: GoalRecord | null): GoalStateEntry {
	return { version: 3, goal: goal ? cloneGoal(goal) : null };
}

function renderGoalResult(result: { details?: unknown; content: Array<{ type: string; text?: string }> }, theme: Theme): Text {
	const first = result.content.find((item) => item.type === "text" && typeof item.text === "string");
	const firstText = first?.text ?? "";
	const details = result.details as GoalStateEntry | undefined;
	if (!details || typeof details !== "object" || !("goal" in details)) {
		return new Text(firstText, 0, 0);
	}
	if (firstText.startsWith("Goal complete.") || firstText.startsWith("Goal paused.") || firstText.startsWith("Goal aborted.") || firstText.startsWith("Goal confirmed and created.")) {
		return new Text(firstText, 0, 0);
	}
	return new Text(theme.fg("accent", "Goal ") + theme.fg("muted", oneLineSummary(details.goal)), 0, 0);
}

function normalizeGoalEventDetails(value: unknown): GoalEventDetails {
	const raw = asRecord(value);
	const kind: GoalEventKind =
		raw?.kind === "stale" ? "stale"
			: raw?.kind === "budget_limit" ? "budget_limit"
				: raw?.kind === "drafting" ? "drafting"
					: "checkpoint";
	const goalId = typeof raw?.goalId === "string" ? raw.goalId : "unknown";
	const focus: DraftingFocus | undefined = raw?.focus === "sisyphus" ? "sisyphus" : raw?.focus === "goal" ? "goal" : undefined;
	const status =
		raw?.status === "active" || raw?.status === "paused" || raw?.status === "complete" || raw?.status === "budgetLimited"
			? (raw.status as GoalStatus)
			: undefined;
	const currentStatus =
		raw?.currentStatus === "active" || raw?.currentStatus === "paused" || raw?.currentStatus === "complete" || raw?.currentStatus === "budgetLimited"
			? (raw.currentStatus as GoalStatus)
			: raw?.currentStatus === null
				? null
				: undefined;
	return {
		kind,
		goalId,
		status,
		objective: typeof raw?.objective === "string" ? raw.objective : undefined,
		timestamp: typeof raw?.timestamp === "number" ? raw.timestamp : undefined,
		currentGoalId: typeof raw?.currentGoalId === "string" || raw?.currentGoalId === null ? raw.currentGoalId : undefined,
		currentStatus,
		focus,
	};
}

function renderGoalEvent(message: { details?: GoalEventDetails }, options: { expanded: boolean }, theme: Theme): Text {
	const details = normalizeGoalEventDetails(message.details);
	const label =
		details.kind === "stale" ? "stale checkpoint"
			: details.kind === "budget_limit" ? "budget limit"
				: details.kind === "drafting" ? (details.focus === "sisyphus" ? "sisyphus drafting" : "goal drafting")
					: "checkpoint";
	if (!options.expanded) {
		return new Text(theme.fg("customMessageLabel", "Goal ") + theme.fg("customMessageText", label), 0, 0);
	}
	const lines = [`Status: ${details.status === "active" ? "running" : details.status ?? "unknown"}`];
	if (details.objective) lines.push(`Objective: ${details.objective}`);
	lines.push(`Goal id: ${details.goalId}`);
	if (details.currentGoalId || details.currentStatus) {
		lines.push(`Current: ${details.currentGoalId ?? "none"}${details.currentStatus ? ` (${details.currentStatus})` : ""}`);
	}
	return new Text(
		theme.fg("customMessageLabel", `Goal ${label}`) + "\n" + theme.fg("customMessageText", lines.join("\n")),
		0,
		0,
	);
}

function extractGoalIdFromInjectedMessage(text: string): string | null {
	// Drafting messages (new goal, sisyphus, or tweak) have no continuation goalId and
	// must never be treated as stale-continuation triggers.
	if (/^\[GOAL (?:DRAFTING|TWEAK DRAFTING)\b/.test(text)) return null;
	// Phase 5 C1: structured outer marker `<pi_goal_continuation goal_id="..." kind="...">`.
	// Borrowed from pi-codex-goal. More robust than bare bracket text because
	// the angle brackets + attributes are nearly impossible for users to type
	// by accident, and the structure is grep-able / parse-able by external tooling.
	const xmlMatch = text.match(/^<pi_goal_continuation\s+goal_id=\"([^\"]+)\"/);
	if (xmlMatch) return xmlMatch[1] ?? null;
	const match = text.match(/^\[(?:GOAL CHECKPOINT|GOAL CONTINUATION|GOAL STALE|GOAL BUDGET LIMIT) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

function extractDraftIdFromInjectedMessage(text: string): string | null {
	const match = text.match(/^\[GOAL DRAFTING\b[^\]]*\bdraftId=([^\]\s]+)/);
	return match?.[1] ?? null;
}

function goalEventMessageId(message: { customType?: string; details?: unknown; content?: unknown }): string | null {
	if (message.customType !== GOAL_EVENT_ENTRY) return null;
	const details = asRecord(message.details);
	// Drafting messages never correspond to a real goal id; they must not be staleness-checked.
	if (details?.kind === "drafting") return null;
	const goalId = details && typeof details.goalId === "string" ? details.goalId : null;
	if (goalId) return goalId;
	return typeof message.content === "string" ? extractGoalIdFromInjectedMessage(message.content) : null;
}

function isAbortedAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "aborted";
}

function isToolUseAssistantMessage(message: unknown): boolean {
	const raw = asRecord(message);
	return raw?.role === "assistant" && raw.stopReason === "toolUse";
}

function hasAbortedAssistantMessage(messages: unknown[]): boolean {
	return messages.some(isAbortedAssistantMessage);
}

function usageChannelTokens(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.max(0, Math.trunc(value));
}

function assistantTurnTokens(message: unknown): number {
	const raw = asRecord(message);
	if (!raw || raw.role !== "assistant") return 0;
	const usage = asRecord(raw.usage);
	if (!usage) return 0;
	return usageChannelTokens(usage.input) + usageChannelTokens(usage.output);
}

function isMeaningfulProgressToolCall(toolName: string, args: unknown): boolean {
	if (!GOAL_PROGRESS_TOOL_SET.has(toolName)) return false;
		if (toolName === "read") {
			const path = asRecord(args)?.path;
			if (typeof path === "string" && (path === ".pi/goals" || path.startsWith(".pi/goals/"))) return false;
		}
		if (toolName === "bash") {
			const command = asRecord(args)?.command;
			if (typeof command === "string" && /^\s*echo\b/.test(command)) return false;
		}
	return true;
}

// ---------- extension entry point ----------

export default function goalExtension(pi: ExtensionAPI): void {
	let goalsById = new Map<string, GoalRecord>();
	let focusedGoalId: string | null = null;
	const state = {
		get goal(): GoalRecord | null {
			return focusedGoalFromPool(goalsById, focusedGoalId);
		},
		set goal(next: GoalRecord | null) {
			if (next) {
				goalsById.set(next.id, next);
				focusedGoalId = next.id;
				return;
			}
			if (focusedGoalId) goalsById.delete(focusedGoalId);
			focusedGoalId = null;
		},
	};
	let continuationQueuedFor: string | null = null;
	let continuationScheduledFor: string | null = null;
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;
	let runningGoalId: string | null = null;
	let terminalInputUnsubscribe: (() => void) | null = null;
	let statusRefreshTimer: ReturnType<typeof setInterval> | null = null;
	let statusRefreshCtx: ExtensionContext | null = null;

	// Per-goal counter for the autoContinue hard cap (#3).
	// Increments each time sendQueuedContinuation actually delivers a continuation.
	const autoContinueTurnsByGoalId = new Map<string, number>();
	const activeGetGoalTurnsByGoalId = new Map<string, number>();
	let autoContinueLimitWarnedFor: string | null = null;

	// Per-turn flags reset in turn_start (#4, C9 fix).
	// goalWorkToolCalledThisTurn: tracks whether a real goal-work tool was called.
	//   If false at turn_end, we don't queue another autoContinue (empty chat turn).
	// turnStoppedFor: set by pause_goal / update_goal(complete) / apply_goal_tweak
	//   after their successful execute. Once set, pi.on("tool_call") blocks all
	//   subsequent in-turn tool calls except POST_STOP_ALLOWED_TOOLS. This is the
	//   schema fix for "agent keeps writing files after pause_goal".
	let goalWorkToolCalledThisTurn = false;
	let turnStoppedFor: string | null = null;

	// #5 post-compaction resync: when a compaction just happened, the next agent
	// turn gets an extra reminder block. Set in session_compact, consumed
	// (cleared) in before_agent_start.
	let postCompactReminderPending = false;

	const accounting = {
		activeGoalId: null as string | null,
		lastAccountedAt: null as number | null,
		budgetWarningSentFor: null as string | null,
	};

	const draftingHiddenWorkTools = [
		"bash",
		"read",
		"write",
		"edit",
		"grep",
		"find",
		"ls",
		SISYPHUS_STEP_TOOL_NAME,
		TWEAK_APPLY_TOOL_NAME,
		CREATE_GOAL_TOOL_NAME,
	] as const;
	const goalExecutionWorkTools = ["read", "bash", "edit", "write"] as const;

	function syncGoalTools(): void {
		try {
			const active = new Set(pi.getActiveTools());
			for (const name of goalExecutionWorkTools) active.add(name);
			active.delete(QUESTION_TOOL_NAME);
			active.delete(QUESTIONNAIRE_TOOL_NAME);
			for (const name of ACTIVE_GOAL_TOOL_NAMES) active.delete(name);
			const phase = draftingFor !== null ? "drafting" : tweakDraftingFor !== null ? "tweakDrafting" : "normal";
			const lifecycleTools = lifecycleToolNamesForGoalStatus(state.goal?.status, phase);
			for (const name of lifecycleTools) active.add(name);
			// Sisyphus is now a prompt/criteria style, not a separate step-counter
			// mechanism. Keep step_complete registered for legacy transcripts, but do
			// not expose it as an active work tool.
			active.delete(SISYPHUS_STEP_TOOL_NAME);
			// apply_goal_tweak is only available during a /goal-tweak drafting flow.
			// Note: tweak drafting can run against active OR paused goals.
			if (state.goal && tweakDraftingFor === state.goal.id) {
				active.add(TWEAK_APPLY_TOOL_NAME);
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			} else {
				active.delete(TWEAK_APPLY_TOOL_NAME);
			}
			// Phase 5 D: propose_goal_draft is only active during /goal-set or
			// /goal-sisyphus drafting; create_goal is HIDDEN during drafting (forcing
			// the agent through the confirm dialog). Outside drafting, neither
			// is shown until a /goal-* command starts a new flow.
			if (draftingFor !== null) {
				for (const name of draftingHiddenWorkTools) active.delete(name);
				const canPropose = draftingFor.questionsAsked > 0
					|| isHeadlessQuestionSufficientForDraft({ topic: draftingFor.originalTopic, questionText: "" });
				if (canPropose) active.add(PROPOSE_DRAFT_TOOL_NAME);
				else active.delete(PROPOSE_DRAFT_TOOL_NAME);
				active.add(QUESTION_TOOL_NAME);
				active.add(QUESTIONNAIRE_TOOL_NAME);
			} else {
				active.delete(PROPOSE_DRAFT_TOOL_NAME);
				// Outside drafting, create_goal stays hidden too — the user must
				// invoke /goal-set or /goal-sisyphus first. This kills the "agent
				// silently creates a goal from a casual message" failure mode.
				active.delete(CREATE_GOAL_TOOL_NAME);
				if (state.goal?.status === "active") {
					for (const name of goalExecutionWorkTools) active.add(name);
				}
			}
			pi.setActiveTools(Array.from(active));
		} catch {}
	}

	function stopStatusRefresh(): void {
		if (statusRefreshTimer) {
			clearInterval(statusRefreshTimer);
			statusRefreshTimer = null;
		}
		statusRefreshCtx = null;
	}

	function syncStatusRefresh(ctx: ExtensionContext): void {
		if (!ctx.hasUI || state.goal?.status !== "active") {
			stopStatusRefresh();
			return;
		}
		statusRefreshCtx = ctx;
		if (statusRefreshTimer) return;
		statusRefreshTimer = setInterval(() => {
			if (!statusRefreshCtx || state.goal?.status !== "active") {
				stopStatusRefresh();
				return;
			}
			const displayGoal = goalForDisplay();
			if (displayGoal) {
				const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
				statusRefreshCtx.ui.setStatus("goal", `${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`);
			}
			// Live-tick the above-editor widget so duration/tokens update.
			goalWidgetComponent?.update();
		}, STATUS_REFRESH_MS);
		statusRefreshTimer.unref?.();
	}

	function clearContinuationTimer(): void {
		if (continuationTimer) {
			clearTimeout(continuationTimer);
			continuationTimer = null;
		}
		continuationScheduledFor = null;
	}

	function clearContinuationState(): void {
		clearContinuationTimer();
		continuationQueuedFor = null;
	}

	function clearActiveAccounting(): void {
		accounting.activeGoalId = null;
		accounting.lastAccountedAt = null;
	}

	function clearStoppedRuntimeState(): void {
		clearContinuationState();
		clearActiveAccounting();
	}

	function resetAutoContinueCap(goalId: string | null | undefined): void {
		if (goalId) {
			autoContinueTurnsByGoalId.delete(goalId);
			activeGetGoalTurnsByGoalId.delete(goalId);
		}
		autoContinueLimitWarnedFor = null;
	}

	function openGoals(): GoalRecord[] {
		return openGoalsFromPool(goalsById);
	}

	function reconcileFocusedGoalFromDisk(ctx: ExtensionContext, opts: { preserveMemoryUsage?: boolean } = {}): boolean {
		const current = state.goal;
		const fresh = readActiveGoalPool(ctx);
		if (!focusedGoalId) {
			goalsById = fresh;
			return true;
		}
		const diskGoal = fresh.get(focusedGoalId) ?? null;
		if (!diskGoal) {
			if (current && !current.activePath) {
				goalsById = fresh;
				goalsById.set(current.id, current);
				focusedGoalId = current.id;
				return true;
			}
			goalsById = fresh;
			focusedGoalId = null;
			clearStoppedRuntimeState();
			accounting.budgetWarningSentFor = null;
			if (current) resetAutoContinueCap(current.id);
			if (tweakDraftingFor !== null) tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			return false;
		}
		const reconciled = current && opts.preserveMemoryUsage
			? mergeFocusedGoalWithDisk({ memoryGoal: current, diskGoal })
			: diskGoal;
		goalsById = fresh;
		goalsById.set(reconciled.id, reconciled);
		focusedGoalId = reconciled.id;
		if (reconciled.status !== "active" || !reconciled.autoContinue) clearContinuationState();
		if (reconciled.status !== "active" && reconciled.status !== "budgetLimited") clearActiveAccounting();
		return true;
	}

	function appendFocusEntry(goalId: string | null, reason: GoalFocusReason): void {
		pi.appendEntry(FOCUS_ENTRY, goalFocusDetails(goalId, reason));
	}

	function setFocusedGoalId(goalId: string | null, ctx: ExtensionContext, reason: GoalFocusReason): void {
		const previousGoalId = focusedGoalId;
		focusedGoalId = goalId && goalsById.has(goalId) ? goalId : null;
		if (previousGoalId !== focusedGoalId) {
			clearContinuationState();
			clearActiveAccounting();
			accounting.budgetWarningSentFor = null;
			resetAutoContinueCap(previousGoalId);
			resetAutoContinueCap(focusedGoalId);
			if (tweakDraftingFor !== null && tweakDraftingFor !== focusedGoalId) tweakDraftingFor = null;
		}
		appendFocusEntry(focusedGoalId, reason);
		syncGoalTools();
		updateUI(ctx);
	}

	function updateFocusedGoal(next: GoalRecord, ctx: ExtensionContext, shouldPersist = true): void {
		const previousGoalId = focusedGoalId;
		goalsById.set(next.id, next);
		focusedGoalId = next.id;
		if (previousGoalId !== focusedGoalId) {
			resetAutoContinueCap(previousGoalId);
			resetAutoContinueCap(focusedGoalId);
		}
		if (shouldPersist) persist(ctx);
		else syncGoalTools();
		updateUI(ctx);
	}

	function armFocusedContinuation(ctx: ExtensionContext): void {
		beginAccounting();
		if (state.goal?.status === "active" && state.goal.autoContinue) queueContinuation(ctx, true);
	}

	function removeFocusedGoal(ctx: ExtensionContext, reason: GoalFocusReason): void {
		const previousGoalId = focusedGoalId;
		if (focusedGoalId) goalsById.delete(focusedGoalId);
		focusedGoalId = null;
		clearStoppedRuntimeState();
		resetAutoContinueCap(previousGoalId);
		appendFocusEntry(null, reason);
		syncGoalTools();
		updateUI(ctx);
	}

	function beginAccounting(): void {
		if (draftingFor !== null || tweakDraftingFor !== null) {
			clearActiveAccounting();
			return;
		}
		if (!state.goal || (state.goal.status !== "active" && state.goal.status !== "budgetLimited")) {
			clearActiveAccounting();
			return;
		}
		accounting.activeGoalId = state.goal.id;
		accounting.lastAccountedAt = Date.now();
	}

	function goalForDisplay(): GoalRecord | null {
		if (!state.goal || state.goal.status !== "active" || accounting.activeGoalId !== state.goal.id || accounting.lastAccountedAt === null) {
			return state.goal;
		}
		const liveSeconds = Math.max(0, Math.floor((Date.now() - accounting.lastAccountedAt) / 1000));
		if (liveSeconds === 0) return state.goal;
		const live = cloneGoal(state.goal);
		live.usage.activeSeconds += liveSeconds;
		return live;
	}

	function accountProgress(
		ctx: ExtensionContext,
		opts: { allowBudgetSteering: boolean; completedTurnTokens?: number; accountBudgetLimited?: boolean },
	): void {
		if (draftingFor !== null || tweakDraftingFor !== null) {
			clearActiveAccounting();
			return;
		}
		if (state.goal?.activePath && !reconcileFocusedGoalFromDisk(ctx, { preserveMemoryUsage: true })) return;
		const canAccount =
			state.goal?.status === "active"
			|| (opts.accountBudgetLimited === true && state.goal?.status === "budgetLimited");
		if (!state.goal || !canAccount || accounting.activeGoalId !== state.goal.id) {
			beginAccounting();
			return;
		}

		const now = Date.now();
		const elapsedSeconds = accounting.lastAccountedAt === null ? 0 : Math.floor((now - accounting.lastAccountedAt) / 1000);
		accounting.lastAccountedAt = now;

		const tokens = Math.max(0, Math.trunc(opts.completedTurnTokens ?? 0));
		if (tokens === 0 && elapsedSeconds === 0) return;

		const wasUnderBudget = state.goal.tokenBudget === null || state.goal.usage.tokensUsed < state.goal.tokenBudget;
		const next = cloneGoal(state.goal);
		next.usage.tokensUsed += tokens;
		next.usage.activeSeconds += elapsedSeconds;
		next.updatedAt = nowIso();
		const newStatus = statusAfterBudgetLimit(next);
		next.status = newStatus;
		state.goal = next;
		persist(ctx);

		const crossedBudget =
			opts.allowBudgetSteering
			&& wasUnderBudget
			&& next.tokenBudget !== null
			&& next.usage.tokensUsed >= next.tokenBudget
			&& accounting.budgetWarningSentFor !== next.id;
		if (crossedBudget) {
			accounting.budgetWarningSentFor = next.id;
			try {
				pi.sendMessage<GoalEventDetails>(
					{
						customType: GOAL_EVENT_ENTRY,
						content: budgetLimitPrompt(next),
						display: false,
						details: {
							kind: "budget_limit",
							goalId: next.id,
							status: next.status,
							objective: next.objective,
							timestamp: Date.now(),
						},
					},
					{ triggerTurn: true, deliverAs: "steer" },
				);
			} catch {}
		}
	}

	function syncGoalPromptFromDisk(ctx: ExtensionContext): boolean {
		if (!state.goal || state.goal.status === "complete") return false;
		const previousObjective = state.goal.objective;
		state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
		return state.goal.objective !== previousObjective;
	}

	function persist(ctx?: ExtensionContext): void {
		const current = state.goal;
		if (current) {
			state.goal = { ...current, updatedAt: nowIso() };
			if (ctx) {
				syncGoalPromptFromDisk(ctx);
				const next = state.goal;
				if (next) state.goal = next.status === "complete" ? archiveGoalFile(ctx, next) : writeActiveGoalFile(ctx, next);
			}
		}
		pi.appendEntry(STATE_ENTRY, goalDetails(state.goal));
		syncGoalTools();
		if (ctx) updateUI(ctx);
	}

	function refreshGoalDisplayFromDisk(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status === "complete") return;
		if (syncGoalPromptFromDisk(ctx)) {
			state.goal = { ...state.goal, updatedAt: nowIso() };
			pi.appendEntry(STATE_ENTRY, goalDetails(state.goal));
		}
		syncGoalTools();
		updateUI(ctx);
	}

	/**
	 * Live above-editor widget for the active goal. Inspired by rpiv-todo's
	 * TodoOverlay: register the widget once with a factory, read live state
	 * via the closure at render time, and call `tui.requestRender()` on every
	 * state change so the overlay refreshes without re-registration.
	 *
	 * Layout (sisyphus, running):
	 *   ◆ Sisyphus  [▰▰▰▱▱] 3/5
	 *   ├─ ⟡ extract validator … wire it … update tests.
	 *   ├─ Status: sisyphus running · auto-continue · 14m 21s · 24.3k tokens
	 *   └─ .pi/goals/active_goal_xxx.md
	 *
	 * Layout (paused with blocker):
	 *   ⊘ Goal paused
	 *   ├─ ⟡ improve benchmark coverage for the parser
	 *   ├─ Status: paused (agent) · 2m 14s · 12.4k tokens
	 *   ├─ Blocker: cannot find the tests directory
	 *   └─ Suggested: ask the user for the test location
	 */
	const GOAL_WIDGET_KEY = "goal";
	let widgetRegistered = false;
	let goalWidgetComponent: GoalWidgetComponent | null = null;

	function clearGoalWidget(ctx: ExtensionContext): void {
		ctx.ui.setStatus("goal", undefined);
		ctx.ui.setWidget(GOAL_WIDGET_KEY, undefined);
		widgetRegistered = false;
		goalWidgetComponent = null;
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		const totalOpen = openGoals().length;
		if (!state.goal && totalOpen === 0) {
			clearGoalWidget(ctx);
			stopStatusRefresh();
			return;
		}
		if (!state.goal) {
			ctx.ui.setStatus("goal", `goal: unfocused [${totalOpen} open] - /goal-focus`);
			if (!widgetRegistered) {
				ctx.ui.setWidget(
					GOAL_WIDGET_KEY,
					(tui, theme) => {
						goalWidgetComponent = new GoalWidgetComponent({
							tui,
							theme,
							getGoal: () => goalForDisplay() ?? state.goal,
							getOpenGoalCount: () => openGoals().length,
						});
						return goalWidgetComponent;
					},
					{ placement: "aboveEditor" },
				);
				widgetRegistered = true;
			} else {
				goalWidgetComponent?.update();
			}
			stopStatusRefresh();
			return;
		}

		const displayGoal = goalForDisplay() ?? state.goal;
		const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
		ctx.ui.setStatus("goal", `${footerStatus(displayGoal)}${otherCount > 0 ? ` (+${otherCount} open)` : ""}`);

		if (!widgetRegistered) {
			ctx.ui.setWidget(
				GOAL_WIDGET_KEY,
				(tui, theme) => {
					goalWidgetComponent = new GoalWidgetComponent({
						tui,
						theme,
						getGoal: () => goalForDisplay() ?? state.goal,
						getOpenGoalCount: () => openGoals().length,
					});
					return goalWidgetComponent;
				},
				{ placement: "aboveEditor" },
			);
			widgetRegistered = true;
		} else {
			goalWidgetComponent?.update();
		}

		if (state.goal.status === "complete") {
			stopStatusRefresh();
		} else {
			syncStatusRefresh(ctx);
		}
	}

	function loadState(ctx: ExtensionContext): void {
		goalsById = readActiveGoalPool(ctx);
		focusedGoalId = null;
		let focusEntry: GoalFocusEntry | null = null;
		let legacyGoal: GoalRecord | null = null;
		let legacyStateSeen = false;
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: unknown };
			if (entry.type !== "custom") continue;
			if (!focusEntry && entry.customType === FOCUS_ENTRY) {
				focusEntry = normalizeGoalFocusEntry(entry.data);
			}
			if (!legacyStateSeen && entry.customType === STATE_ENTRY) {
				legacyGoal = normalizeGoalRecord(asRecord(entry.data)?.goal);
				legacyStateSeen = true;
			}
			if (focusEntry && legacyStateSeen) break;
		}
		if (legacyGoal && legacyGoal.status !== "complete") {
			legacyGoal = sanitizeGoalPaths(ctx, mergeGoalPromptFromDisk(ctx, legacyGoal));
		}
		focusedGoalId = resolveSessionFocus({ pool: goalsById, focusEntry, legacyGoal });
		if (!focusEntry && focusedGoalId) {
			try {
				appendFocusEntry(focusedGoalId, legacyGoal?.id === focusedGoalId ? "migrated" : "selected");
			} catch {}
		}
		for (const [id, current] of goalsById) {
			if (current.status === "complete") {
				goalsById.delete(id);
			}
		}
		clearStoppedRuntimeState();
		accounting.budgetWarningSentFor = null;
		runningGoalId = null;
		syncGoalTools();
		updateUI(ctx);
	}

	function setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist = true, focusReason?: GoalFocusReason): void {
		const previousGoalId = state.goal?.id ?? null;
		state.goal = next;
		const focusChanged = previousGoalId !== focusedGoalId;
		if (focusChanged) {
			clearContinuationState();
			clearActiveAccounting();
			resetAutoContinueCap(previousGoalId);
			resetAutoContinueCap(focusedGoalId);
		}
		if (focusReason && focusChanged) appendFocusEntry(focusedGoalId, focusReason);
		if (!state.goal || (state.goal.status !== "active" && state.goal.status !== "budgetLimited") || !state.goal.autoContinue) {
			clearContinuationState();
		}
		if (!state.goal || state.goal.status === "paused" || state.goal.status === "complete") {
			clearActiveAccounting();
		}
		if (!state.goal || state.goal.id !== previousGoalId) {
			accounting.budgetWarningSentFor = null;
			// Drop any stale tweak-edit-gate that didn't belong to this goal.
			if (tweakDraftingFor !== null && tweakDraftingFor !== state.goal?.id) tweakDraftingFor = null;
		}
		if (shouldPersist) persist(ctx);
		else syncGoalTools();
		updateUI(ctx);
	}

	function archiveCurrentGoal(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null {
		if (!state.goal) return null;
		let archived = mergeGoalPromptFromDisk(ctx, state.goal);
		archived = { ...archived, status: archived.status === "complete" ? "complete" : "paused", stopReason: reason };
		return archiveGoalFile(ctx, archived);
	}

	function stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void {
		if (!state.goal) return;
		let next = mergeGoalPromptFromDisk(ctx, state.goal);
		next = { ...next, status, stopReason: reason, updatedAt: nowIso() };
		setGoal(next, ctx);
	}

	function pauseActiveGoal(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status !== "active") return;
		const pausedGoalId = state.goal.id;
		// User-initiated pause (Esc / aborted turn). Clear any stale agent pause reason.
		state.goal = { ...state.goal, autoContinue: false, pauseReason: undefined, pauseSuggestedAction: undefined };
		stopActiveGoal("paused", "user", ctx);
		resetAutoContinueCap(pausedGoalId);
		ctx.ui.notify("Goal paused.", "info");
	}

	function syncTerminalInputPause(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = ctx.ui.onTerminalInput((data) => {
			if (matchesKey(data, "escape") && state.goal?.status === "active" && state.goal.autoContinue) {
				pauseActiveGoal(ctx);
			}
			return undefined;
		});
	}

	function sendQueuedContinuation(ctx: ExtensionContext, goalId: string): void {
		continuationTimer = null;
		continuationScheduledFor = null;
		syncGoalTools();
		if (!state.goal || state.goal.id !== goalId || state.goal.status !== "active" || !state.goal.autoContinue) {
			if (continuationQueuedFor === goalId) continuationQueuedFor = null;
			return;
		}

		let ready: boolean;
		try {
			ready = !ctx.hasPendingMessages() && ctx.isIdle();
		} catch {
			if (continuationQueuedFor === goalId) continuationQueuedFor = null;
			return;
		}

		if (!ready) {
			continuationScheduledFor = goalId;
			continuationTimer = setTimeout(() => sendQueuedContinuation(ctx, goalId), CONTINUATION_IDLE_RETRY_MS);
			continuationTimer.unref?.();
			return;
		}
		continuationQueuedFor = goalId;
		pi.sendMessage<GoalEventDetails>(
			{
				customType: GOAL_EVENT_ENTRY,
				content: continuationPrompt(state.goal),
				display: false,
				details: {
					kind: "checkpoint",
					goalId: state.goal.id,
					status: state.goal.status,
					objective: state.goal.objective,
					timestamp: Date.now(),
				},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function pauseForAutoContinueCap(ctx: ExtensionContext): boolean {
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return false;
		const goalId = state.goal.id;
		const autoContinueTurns = autoContinueTurnsByGoalId.get(goalId) ?? 0;
		if (!shouldAutoPauseForContinueCap({ goal: state.goal, autoContinueTurns, maxTurns: MAX_AUTOCONTINUE_TURNS })) return false;
		if (autoContinueLimitWarnedFor !== goalId) {
			autoContinueLimitWarnedFor = goalId;
			try {
				ctx.ui.notify(
					`Auto-continue cap reached (${MAX_AUTOCONTINUE_TURNS} turns) for the active goal. Pausing. Use /goal-resume if you want to keep going.`,
					"warning",
				);
			} catch {}
			setGoal(buildAutoContinueCapPause(state.goal, { maxTurns: MAX_AUTOCONTINUE_TURNS, updatedAt: nowIso() }), ctx);
		}
		clearContinuationState();
		turnStoppedFor = goalId;
		updateUI(ctx);
		return true;
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		if (draftingFor !== null || tweakDraftingFor !== null) return;
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return;
		const goalId = state.goal.id;
		// Hard cap (#3): if this active goal has already chained MAX turns,
		// auto-pause and stop scheduling. Prevents runaway chat-only loops.
		if (pauseForAutoContinueCap(ctx)) return;
		if (!force && (continuationQueuedFor === goalId || continuationScheduledFor === goalId)) return;
		clearContinuationTimer();
		let delay = CONTINUATION_IDLE_RETRY_MS;
		try {
			delay = ctx.isIdle() && !ctx.hasPendingMessages() ? 0 : CONTINUATION_IDLE_RETRY_MS;
		} catch {
			return;
		}
		continuationScheduledFor = goalId;
		continuationTimer = setTimeout(() => sendQueuedContinuation(ctx, goalId), delay);
		continuationTimer.unref?.();
	}

	function queueDraftingNudge(ctx: ExtensionContext, draft: DraftingState): void {
		const prior = draftingNudgesByDraftId.get(draft.draftId) ?? 0;
		if (prior >= 3) return;
		draftingNudgesByDraftId.set(draft.draftId, prior + 1);
		const hasQuestion = draft.questionsAsked > 0;
		const content = hasQuestion
			? `[GOAL DRAFTING focus=${draft.focus} draftId=${draft.draftId}]
The required drafting question has already been asked. The original topic is concrete enough. Your next action MUST be a propose_goal_draft tool call with draftId=${draft.draftId}. Do not ask more questions, do not use normal text, and do not use work tools.`
			: `[GOAL DRAFTING focus=${draft.focus} draftId=${draft.draftId}]
Drafting is still active, but your last response did not use a question tool. Plain assistant text does not satisfy the runtime gate. Your next action MUST be goal_question or goal_questionnaire. Ask one minimal calibration question with a recommended default; if the topic is already concrete, immediately call propose_goal_draft after that question.`;
		pi.sendMessage<GoalEventDetails>(
			{
				customType: GOAL_EVENT_ENTRY,
				content,
				display: false,
				details: {
					kind: "drafting",
					goalId: draft.draftId,
					status: "active",
					objective: draft.originalTopic,
					timestamp: Date.now(),
				},
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	function replaceGoal(config: GoalCreationConfig, ctx: ExtensionContext, startNow = true): void {
		setGoal(createGoal(config), ctx, true, "created");
		beginAccounting();
		// Reset hard-cap counter — this is a fresh goal.
		resetAutoContinueCap(state.goal?.id);
		// A goal was committed — clear drafting state if any.
		if (draftingFor) draftingNudgesByDraftId.delete(draftingFor.draftId);
		draftingFor = null;
		ctx.ui.notify(buildGoalRunningNotification(config), "info");
		if (startNow && state.goal?.autoContinue) queueContinuation(ctx, true);
	}

	async function startGoalTweakDrafting(hint: string, ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		clearContinuationState();
		clearActiveAccounting();
		if (!state.goal) {
			if (openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Tweak which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify("No goal is set. Use /goal-set or /goal-sisyphus to start one.", "warning");
				return;
			}
		}
		const currentGoal = state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify("Goal is complete. Use /goal-set to start a new one.", "warning");
			return;
		}
		syncGoalPromptFromDisk(ctx);
		persist(ctx);
		const trimmed = hint.trim();
		const focused = state.goal;
		if (!focused) return;
		const sisyphusOn = focused.sisyphus;
		const label = sisyphusOn ? "Sisyphus tweak drafting" : "Goal tweak drafting";
		// Activate the tweak edit-gate so apply_goal_tweak is callable.
		tweakDraftingFor = focused.id;
		syncGoalTools();
		ctx.ui.notify(
			`${label} started${trimmed ? `: ${truncateText(trimmed, 60)}` : ""}. The agent will interview you and then call apply_goal_tweak.`,
			"info",
		);
		const draftId = `tweak-${focused.id}-${Date.now().toString(36)}`;
		try {
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content: goalTweakDraftingPrompt(focused, trimmed),
					display: false,
					details: {
						kind: "drafting",
						goalId: draftId,
						objective: trimmed,
						focus: sisyphusOn ? "sisyphus" : "goal",
						timestamp: Date.now(),
					},
				},
				{ triggerTurn: true, deliverAs: ctx.isIdle() ? "followUp" : "steer" },
			);
		} catch (err) {
			tweakDraftingFor = null;
			syncGoalTools();
			ctx.ui.notify(`Could not start goal tweak: ${(err as Error).message}`, "error");
		}
	}

	function startGoalDrafting(topic: string, focus: DraftingFocus, ctx: ExtensionContext): void {
		clearContinuationState();
		clearActiveAccounting();
		const trimmed = topic.trim();
		const label = focus === "sisyphus" ? "Sisyphus drafting" : "Goal drafting";
		const hint = focus === "sisyphus"
			? "The agent will work out explicit numbered steps, then propose a draft for you to Confirm. No skipping, no rushing."
			: "The agent will clarify objective + boundaries, then propose a draft for you to Confirm.";
		ctx.ui.notify(
			`${label} started${trimmed ? `: ${truncateText(trimmed, 60)}` : ""}. ${hint}`,
			"info",
		);

		const draftId = `draft-${focus}-${Date.now().toString(36)}`;
		// Phase 5 D + B1: arm drafting state. Schema gate fires when the
		// agent calls propose_goal_draft. create_goal becomes hidden.
		draftingFor = {
			focus,
			originalTopic: trimmed,
			draftId,
			startedAt: Date.now(),
			questionsAsked: 0,
		};
		draftingNudgesByDraftId.delete(draftId);
		syncGoalTools();
		try {
			pi.sendMessage<GoalEventDetails>(
				{
					customType: GOAL_EVENT_ENTRY,
					content: goalDraftingPrompt(trimmed, focus, draftId),
					display: false,
					details: {
						kind: "drafting",
						goalId: draftId,
						objective: trimmed,
						focus,
						timestamp: Date.now(),
					},
				},
				{ triggerTurn: true, deliverAs: ctx.isIdle() ? "followUp" : "steer" },
			);
		} catch (err) {
			ctx.ui.notify(`Could not start ${label.toLowerCase()}: ${(err as Error).message}`, "error");
		}
	}

	async function chooseOpenGoal(ctx: ExtensionContext, title: string): Promise<GoalRecord | null> {
		reconcileFocusedGoalFromDisk(ctx);
		if (state.goal && state.goal.status !== "complete") return state.goal;
		const open = openGoals();
		if (open.length === 0) return null;
		if (open.length === 1) {
			const only = open[0];
			if (!only) return null;
			setFocusedGoalId(only.id, ctx, "selected");
			return state.goal;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(buildUnfocusedOpenGoalsSummary(open.length), "warning");
			return null;
		}
		const labels = open.map((item) => goalSelectorLabel(item, focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		const selected = await ctx.ui.select(title, labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			ctx.ui.notify("Goal focus unchanged.", "info");
			return null;
		}
		setFocusedGoalId(selectedId, ctx, "selected");
		return state.goal;
	}

	async function focusGoalCommand(ctx: ExtensionContext): Promise<void> {
		const open = openGoals();
		if (open.length === 0) {
			ctx.ui.notify("No open goals. Use /goal-set or /goal-sisyphus to start one.", "warning");
			return;
		}
		if (open.length === 1) {
			const only = open[0];
			if (!only) return;
			setFocusedGoalId(only.id, ctx, "selected");
			armFocusedContinuation(ctx);
			ctx.ui.notify(`Focused goal: ${oneLineSummary(only)}`, "info");
			return;
		}
		if (!ctx.hasUI) {
			ctx.ui.notify(buildGoalListText(goalsById, focusedGoalId), "info");
			return;
		}
		const labels = open.map((item) => goalSelectorLabel(item, focusedGoalId));
		const byLabel = new Map(labels.map((label, index) => [label, open[index]?.id]));
		const selected = await ctx.ui.select("Focus open goal", labels);
		const selectedId = selected ? byLabel.get(selected) : undefined;
		if (!selectedId) {
			ctx.ui.notify("Goal focus unchanged.", "info");
			return;
		}
		setFocusedGoalId(selectedId, ctx, "selected");
		armFocusedContinuation(ctx);
		ctx.ui.notify(`Focused goal: ${oneLineSummary(state.goal)}`, "info");
	}

	async function handleGoalCommandTopic(rawTopic: string, ctx: ExtensionContext, focus: DraftingFocus, opts: { replace: boolean }): Promise<void> {
		const topic = rawTopic.trim();
		pendingBudget = parseTokenBudgetFromTopic(topic);
		if (opts.replace) {
			const replacementTarget = await chooseOpenGoal(ctx, "Replace which open goal?");
			if (openGoals().length > 0 && !replacementTarget) return;
			archiveCurrentGoal(ctx, "user");
			setGoal(null, ctx, true, "cleared");
		}
		startGoalDrafting(topic, focus, ctx);
	}

	async function showGoalStatus(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (state.goal) syncGoalPromptFromDisk(ctx);
		const view = goalForDisplay() ?? state.goal;
		const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
		const extra = view && otherCount > 0 ? `\nOther open goals: ${otherCount} (run /goal-list or /goal-focus)` : "";
		const text = view ? `${detailedSummary(view)}${extra}` : openGoals().length > 0 ? buildUnfocusedOpenGoalsSummary(openGoals().length) : detailedSummary(null);
		ctx.ui.notify(text, "info");
		updateUI(ctx);
	}

	async function handleGoalPause(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal) {
			if (openGoals().length > 0) {
				const selected = await chooseOpenGoal(ctx, "Pause which open goal?");
				if (!selected) return;
			} else {
				ctx.ui.notify("No goal is set.", "warning");
				return;
			}
		}
		const currentGoal = state.goal;
		if (!currentGoal) return;
		if (currentGoal.status === "complete") {
			ctx.ui.notify("Goal is complete.", "warning");
			return;
		}
		if (currentGoal.status === "paused") {
			ctx.ui.notify("Goal is already paused. Use /goal-resume to continue.", "info");
			return;
		}
		if (currentGoal.status === "budgetLimited") {
			ctx.ui.notify("Goal is budget-limited (not running).", "info");
			return;
		}
		pauseActiveGoal(ctx);
	}

	async function handleGoalResume(ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Resume or focus open goal");
			if (!selected) return;
			if (selected.status === "active") {
				armFocusedContinuation(ctx);
				ctx.ui.notify(`Goal focused: ${oneLineSummary(selected)}`, "info");
				return;
			}
		}
		const resumeGate = validateResumeGoal(state.goal);
		if (!resumeGate.ok) {
			const level = resumeGate.message.includes("already running") ? "info" : "warning";
			ctx.ui.notify(resumeGate.message, level);
			return;
		}
		if (!state.goal) throw new Error("Goal disappeared during resume validation.");
		setGoal(
			{
				...mergeGoalPromptFromDisk(ctx, state.goal),
				status: "active",
				autoContinue: true,
				stopReason: undefined,
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			},
			ctx,
		);
		beginAccounting();
		resetAutoContinueCap(state.goal.id);
		ctx.ui.notify("Goal resumed.", "info");
		queueContinuation(ctx, true);
	}

	async function handleGoalBudget(rawArgs: string, ctx: ExtensionContext): Promise<void> {
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Update budget for which open goal?");
			if (!selected) return;
		}
		if (!state.goal) {
			ctx.ui.notify("No goal is set.", "warning");
			return;
		}
		const parsed = parseGoalBudgetUpdate(rawArgs);
		if (!parsed.ok) {
			ctx.ui.notify(parsed.message, "warning");
			return;
		}
		const next = applyGoalBudgetUpdate(state.goal, { tokenBudget: parsed.tokenBudget, updatedAt: nowIso() });
		setGoal(next, ctx);
		resetAutoContinueCap(next.id);
		if (next.status === "active" && next.autoContinue) {
			beginAccounting();
			queueContinuation(ctx, true);
		}
		ctx.ui.notify(`Goal budget updated: ${parsed.label}.`, "info");
	}

	async function handleGoalClear(ctx: ExtensionContext): Promise<void> {
		if (draftingFor !== null || tweakDraftingFor !== null) {
			draftingFor = null;
			tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			ctx.ui.notify(clearGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Clear which open goal?");
			if (!selected) return;
		}
		const archived = archiveCurrentGoal(ctx, "user");
		const didArchive = !!archived;
		resetAutoContinueCap(state.goal?.id);
		setGoal(null, ctx, true, "cleared");
		// Phase 5 D: also abort any in-flight drafting so the agent's next turn
		// doesn't try to propose into a cleared slot.
		const wasDrafting = draftingFor !== null;
		draftingFor = null;
		syncGoalTools();
		const msg = clearGoalCommandMessage({ archived: didArchive, wasDrafting });
		ctx.ui.notify(msg, didArchive || wasDrafting ? "info" : "warning");
	}

	async function handleGoalAbort(ctx: ExtensionContext): Promise<void> {
		if (draftingFor !== null || tweakDraftingFor !== null) {
			draftingFor = null;
			tweakDraftingFor = null;
			syncGoalTools();
			updateUI(ctx);
			ctx.ui.notify(abortGoalCommandMessage({ archived: false, wasDrafting: true }), "info");
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal && openGoals().length > 0) {
			const selected = await chooseOpenGoal(ctx, "Abort which open goal?");
			if (!selected) return;
		}
		const archived = archiveCurrentGoal(ctx, "user");
		const didArchive = !!archived;
		resetAutoContinueCap(state.goal?.id);
		setGoal(null, ctx, true, "aborted");
		const wasDrafting = draftingFor !== null;
		draftingFor = null;
		syncGoalTools();
		const msg = abortGoalCommandMessage({ archived: didArchive, wasDrafting });
		ctx.ui.notify(msg, didArchive || wasDrafting ? "info" : "warning");
	}

	pi.registerMessageRenderer<GoalEventDetails>(GOAL_EVENT_ENTRY, renderGoalEvent);

	// /goal and /goal-status: read-only status display.
	const statusCommand = {
		description: "Show the current goal: objective, status, sisyphus mode, usage, budget.",
		handler: async (_rawArgs: string, ctx: ExtensionContext) => {
			await showGoalStatus(ctx);
		},
	};
	pi.registerCommand("goal", {
		description: "Show focused goal status. Manage goals with /goal-set, /goal-sisyphus, /goal-list, /goal-focus, /goal-tweak, /goal-replace, /goal-clear, /goal-abort, /goal-pause, /goal-resume.",
		handler: statusCommand.handler,
	});
	pi.registerCommand("goal-status", statusCommand);
	pi.registerCommand("goal-list", {
		description: "List all open pi goals and show which one this session is focused on.",
		handler: async (_rawArgs, ctx) => {
			reconcileFocusedGoalFromDisk(ctx);
			ctx.ui.notify(buildGoalListText(goalsById, focusedGoalId), "info");
			updateUI(ctx);
		},
	});
	pi.registerCommand("goal-focus", {
		description: "Choose which open goal this session should focus on.",
		handler: async (_rawArgs, ctx) => {
			await focusGoalCommand(ctx);
		},
	});

	// /goal-set <topic>: drafting -> new normal goal (objective / criteria / boundaries).
	pi.registerCommand("goal-set", {
		description: "Draft a new goal. The agent interviews you for objective, success criteria, and boundaries, then creates the goal.",
		handler: async (rawArgs, ctx) => {
			await handleGoalCommandTopic(rawArgs, ctx, "goal", { replace: false });
		},
	});

	// /goal-sisyphus <topic>: drafting -> new Sisyphus goal.
	pi.registerCommand("goal-sisyphus", {
		description: "Draft a Sisyphus goal. The agent grills you for the ordered style, completion standard, and boundaries before proposing a draft.",
		handler: async (rawArgs: string, ctx: ExtensionContext) => {
			await handleGoalCommandTopic(rawArgs, ctx, "sisyphus", { replace: false });
		},
	});

	// /goal-tweak [hint]: drafting on top of the current goal -> edits the active goal file.
	pi.registerCommand("goal-tweak", {
		description: "Refine the current goal via a drafting interview. The agent asks what to change, then edits the active goal file with the revised objective.",
		handler: async (rawArgs, ctx) => {
			await startGoalTweakDrafting(rawArgs, ctx);
		},
	});

	// /goal-replace <topic>: drop the current goal without confirm, then draft a new normal goal.
	pi.registerCommand("goal-replace", {
		description: "Drop the current goal (no confirm) and draft a new one. Pass <topic> to seed the drafting interview.",
		handler: async (rawArgs, ctx) => {
			await handleGoalCommandTopic(rawArgs, ctx, "goal", { replace: true });
		},
	});

	// /goal-clear: archive the current goal.
	pi.registerCommand("goal-clear", {
		description: "Archive the current goal.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalClear(ctx);
		},
	});

	// /goal-abort: abandon and archive the current goal, or cancel drafting.
	pi.registerCommand("goal-abort", {
		description: "Abort the current goal and archive it, or cancel an in-progress drafting flow.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalAbort(ctx);
		},
	});

	// /goal-pause: pause the currently running goal.
	pi.registerCommand("goal-pause", {
		description: "Pause the currently running goal. Esc also pauses while a goal is running.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalPause(ctx);
		},
	});

	// /goal-resume: resume a paused goal.
	pi.registerCommand("goal-resume", {
		description: "Resume a paused goal.",
		handler: async (_rawArgs, ctx) => {
			await handleGoalResume(ctx);
		},
	});

	pi.registerCommand("goal-budget", {
		description: "Set or remove the focused goal's token budget. Use /goal-budget <tokens|none>.",
		handler: async (rawArgs, ctx) => {
			await handleGoalBudget(rawArgs, ctx);
		},
	});

	registerQuestionnaireTools(pi);

	pi.registerTool(defineTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current pi goal for this session: objective, status, auto-continue, token budget, usage, and local file paths.",
		promptSnippet: "Read the active pi goal state for the current session.",
		promptGuidelines: [
			"Use get_goal when you need the current goal before deciding whether to continue or mark it complete.",
			"Before marking a goal complete, compare every explicit requirement with concrete evidence from the workspace/session.",
			"If the returned goal has sisyphus mode on, you must execute strictly step-by-step in the order written in the objective; do not skip, combine, or rush steps, and stop to ask the user when blocked or unclear.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (state.goal) syncGoalPromptFromDisk(ctx);
			syncGoalTools();
			const view = goalForDisplay() ?? state.goal;
			const otherCount = otherOpenGoalCount(goalsById, focusedGoalId);
			const lifecycleHint = view && (view.status === "active" || view.status === "budgetLimited" || view.status === "paused")
				? "\nLifecycle tools: if evidence proves the objective is satisfied, call update_goal({status: \"complete\"}); if blocked, call pause_goal({reason, suggestedAction?}); if abandoned/obsolete/unsafe, call abort_goal({reason}). For file or shell work, use the normal work tools directly (write/read/bash/edit); do not call get_goal repeatedly just to look for tools."
				: "";
			const text = view
				? `${detailedSummary(view)}${lifecycleHint}${otherCount > 0 ? `\nOther open goals: ${otherCount} (human can run /goal-list or /goal-focus)` : ""}`
				: openGoals().length > 0
					? buildUnfocusedOpenGoalsSummary(openGoals().length)
					: detailedSummary(null);
			return {
				content: [{ type: "text", text }],
				details: goalDetails(view),
			};
		},
		renderCall(_args, theme) {
			return new Text(theme.fg("toolTitle", "get_goal"), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "create_goal",
		label: "Create Goal",
		description: "Create a new active pi goal and focus it. Hidden outside drafting flows; propose_goal_draft is the normal commit path.",
		promptSnippet: "Create a persistent pi goal when the user explicitly asks for one or when a goal-drafting interview has converged.",
		promptGuidelines: [
			"Use create_goal only when the user explicitly asks to start a long-running goal, OR when a /goal-set or /goal-sisyphus drafting interview has produced a concrete objective.",
			"Creating a new goal focuses it and leaves other open goals untouched. Do not archive or replace existing goals unless the user invoked /goal-replace.",
			"Pass sisyphus=true only when the goal came out of /goal-sisyphus drafting or when the user explicitly invoked Sisyphus mode.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Concrete objective to pursue. For Sisyphus goals this MUST be the full plan including numbered steps and per-step done criteria." }),
			autoContinue: Type.Optional(Type.Boolean({ description: "Whether pi should keep sending continuation prompts until complete. Defaults to true." })),
			sisyphus: Type.Optional(Type.Boolean({ description: "When true, mark this as a Sisyphus goal: the agent must execute strictly step-by-step, no skipping, no rushing, no improvising. Default false." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			return {
				content: [{ type: "text", text: "create_goal REJECTED: direct goal creation is disabled. Use /goal-set or /goal-sisyphus and propose_goal_draft so the user can confirm the goal." }],
				details: goalDetails(state.goal),
			};
			/* legacy implementation kept unreachable for old transcript shape reference
			const budget = pendingBudget;
			pendingBudget = null; // consumed
			const config: GoalCreationConfig = {
				objective: params.objective.trim(),
				autoContinue: params.autoContinue ?? true,
				tokenBudget: budget,
				sisyphus: params.sisyphus === true,
			};
			if (!config.objective) throw new Error("Goal objective must not be empty.");
			replaceGoal(config, ctx, false);
			return {
				content: [{ type: "text", text: buildGoalCreatedReport({ objective: config.objective, detailedSummary: detailedSummary(state.goal) }) }],
				details: goalDetails(state.goal),
			};
			*/
		},
		renderCall(args, theme) {
			const prefix = args?.sisyphus ? "create_goal sisyphus " : "create_goal ";
			return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", args?.objective ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	// Phase 5 D + B0/B1: agent's drafting-time entry point. Replaces create_goal
	// during /goal-set or /goal-sisyphus drafting. Shows the user a full plain-text
	// draft report with two choices: [Confirm] (creates the goal) or
	// [Continue Chatting] (returns control to the agent for more interview). Schema gates:
	//   B0 required question
	//   B1 focus-vs-sisyphus consistency
	// In headless mode (no UI), auto-confirms — harness-friendly.
	pi.registerTool(defineTool({
		name: PROPOSE_DRAFT_TOOL_NAME,
		label: "Propose Goal Draft",
		description: "During /goal-set or /goal-sisyphus drafting, propose the goal draft to the user. The user sees a full plain-text confirmation report and chooses Confirm (creates the goal) or Continue Chatting (returns control to you to refine). REPLACES create_goal during drafting.",
		promptSnippet: "Propose the drafted goal to the user with a full plain-text Confirm / Continue Chatting dialog.",
		promptGuidelines: [
			"Call propose_goal_draft ONLY when you are inside a /goal-set or /goal-sisyphus drafting flow AND you have asked at least one concrete question with goal_question, goal_questionnaire, or another question-like user-dialogue tool. The B0 schema gate rejects direct proposals.",
			"After that required question, call propose_goal_draft only when you have enough info to write a concrete goal. If the answer exposes ambiguity, keep interviewing the user — do not propose prematurely.",
			"The user will see a full plain-text draft report plus a [Confirm] / [Continue Chatting] choice. Confirm creates the goal; Continue Chatting returns control to you to ask follow-up questions.",
			"If the tool returns 'continue chatting', ask the user what they want changed. Do NOT propose again immediately with the same content; iterate based on their feedback first.",
			"The sisyphus field must match the user's drafting focus: /goal-sisyphus → sisyphus=true, /goal-set → sisyphus=false. The schema enforces this; mismatched proposals are REJECTED.",
			"For sisyphus goals, preserve the user's requested ordered style and completion standard. Do not add reconnaissance/preflight steps, merge steps, reorder steps, or change the mode without explicit user confirmation.",
			"create_goal is hidden from you during drafting; propose_goal_draft is the only commit path. This is intentional — the user wants explicit say in goal creation.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Full goal text. For Sisyphus goals this MUST include the user's numbered steps + per-step done criteria, taken faithfully from the user's input." }),
			autoContinue: Type.Optional(Type.Boolean({ description: "Whether pi should keep sending continuation prompts until complete. Default true." })),
			sisyphus: Type.Optional(Type.Boolean({ description: "Must equal true for /goal-sisyphus drafting, false for /goal-set drafting. Schema-enforced via B1 gate." })),
			draftId: Type.Optional(Type.String({ description: "Draft id from the [GOAL DRAFTING ... draftId=...] prompt. Required when present to reject stale overlapping drafts." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const validation = validateGoalDraftProposal({
				drafting: draftingFor,
				hasUnfinishedGoal: !!state.goal && state.goal.status !== "complete",
				objective: params.objective,
				sisyphus: params.sisyphus,
				draftId: params.draftId,
			});
			if (!validation.ok) {
				if (validation.clearDrafting) {
					draftingFor = null;
					syncGoalTools();
				}
				return {
					content: [{ type: "text", text: validation.message }],
					details: goalDetails(state.goal),
				};
			}
			const activeDrafting = draftingFor;
			if (!activeDrafting) throw new Error("Drafting state disappeared during proposal validation.");

			// All schema gates passed. Decide how to confirm.
			const objective = validation.objective;
			const autoContinueFlag = params.autoContinue ?? true;
			const sisyphusFlag = validation.expectedSisyphus;
			const budgetFromTopic = pendingBudget;
			const draftSummary = buildDraftConfirmationText({
				focus: activeDrafting.focus,
				originalTopic: activeDrafting.originalTopic,
				objective,
				autoContinue: autoContinueFlag,
				tokenBudget: budgetFromTopic,
			});

			const headless = shouldAutoConfirmProposal({ hasUI: ctx.hasUI, autoConfirmEnv: process.env.PI_GOAL_AUTO_CONFIRM });

			let decision: "confirm" | "continue";
			if (headless) {
				// Headless: auto-confirm (tests and non-TUI sessions).
				decision = "confirm";
			} else {
				// TUI: show overlay dialog.
				try {
					decision = await showProposalDialog(ctx, draftSummary, activeDrafting.focus);
				} catch (err) {
					const message = proposalDialogFailureMessage(err);
					ctx.ui.notify(message, "error");
					return {
						content: [{ type: "text", text: message }],
						details: goalDetails(state.goal),
					};
				}
			}

			if (decision === "confirm") {
				const config: GoalCreationConfig = {
					objective,
					autoContinue: autoContinueFlag,
					tokenBudget: budgetFromTopic,
					sisyphus: sisyphusFlag,
				};
				pendingBudget = null; // consumed
				draftingFor = null;
				replaceGoal(config, ctx, false);
				syncGoalTools();
				return {
					content: [{ type: "text", text: buildGoalCreatedReport({ objective, detailedSummary: detailedSummary(state.goal) }) }],
					details: goalDetails(state.goal),
					terminate: true,
				};
			}
			// "continue" — user wants to keep chatting. Drafting state stays armed.
			return {
				content: [{
					type: "text",
					text: "User clicked 'Continue Chatting'. The goal was NOT created. Ask the user what they want to change about the draft (objective, scope, criteria, steps), then revise and call propose_goal_draft again. Do not call propose_goal_draft again with the same content — wait for the user's input first.",
				}],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			const prefix = args?.sisyphus ? "propose_goal_draft sisyphus " : "propose_goal_draft ";
			return new Text(theme.fg("toolTitle", prefix) + theme.fg("muted", truncateText(args?.objective ?? "", 80)), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Mark the current active or paused pi goal complete when the objective is actually achieved.",
		promptSnippet: "Mark the active or paused pi goal complete when the objective is achieved.",
		promptGuidelines: [
			"Use update_goal with status=complete only when the pi goal objective has actually been achieved and no required work remains.",
			"Before calling update_goal, map every explicit requirement in the objective to concrete evidence from files, command output, test results, PR state, or other real artifacts; uncertainty means the goal is not complete.",
			"Do not call update_goal merely because work is stopping, substantial progress was made, tests passed without covering every requirement, or the token budget is nearly exhausted.",
			"Do not use update_goal=complete as an escape hatch when you are blocked. If you are blocked, call pause_goal({reason, suggestedAction?}) instead so the user can intervene.",
			"For sisyphus goals, do not mark complete until every numbered step has been executed and individually verified against its done criterion.",
		],
		parameters: Type.Object({
			status: StringEnum([COMPLETE_STATUS] as const, { description: "Set to complete only when the objective is achieved." }),
			completionSummary: Type.Optional(Type.String({ description: "Optional concise completion report or evidence summary to show verbatim in the tool result." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (params.status !== COMPLETE_STATUS) throw new Error("update_goal only supports status=complete.");
			const completionGate = validateGoalCompletion({ goal: state.goal, runningGoalId });
			if (!completionGate.ok) {
				return {
					content: [{ type: "text", text: completionGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during completion validation.");
			// Account for any remaining elapsed time before stopping.
			accountProgress(ctx, { allowBudgetSteering: false, accountBudgetLimited: true });
			state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
			stopActiveGoal("complete", "agent", ctx);
			const completedGoal = state.goal;
			// C9 fix: mark turn-stopped so subsequent in-turn tool calls are blocked.
			turnStoppedFor = completedGoal?.id ?? null;
			if (completedGoal) {
				resetAutoContinueCap(completedGoal.id);
				goalsById.delete(completedGoal.id);
				focusedGoalId = null;
				appendFocusEntry(null, "completed");
				syncGoalTools();
				updateUI(ctx);
			}
			return {
				content: [{
					type: "text",
					text: buildCompletionReport({
						detailedSummary: detailedSummary(completedGoal),
						completionSummary: params.completionSummary,
					}),
				}],
				details: goalDetails(completedGoal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "update_goal ") + theme.fg("success", args.status), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "pause_goal",
		label: "Pause Goal",
		description: "Pause the active pi goal and report a blocker to the user. The user must /goal-resume, /goal-tweak, or /goal-clear before work continues.",
		promptSnippet: "Pause the active pi goal and report a concrete blocker so the user can intervene.",
		promptGuidelines: [
			"Use pause_goal when you have hit a real blocker that you cannot resolve with one more reasonable next step: missing credentials, ambiguous or contradictory spec, a file or permission you cannot access, a sisyphus step whose precondition is not in the plan, or any irreversible / dangerous operation that requires explicit user approval.",
			"Do NOT use pause_goal to escape a merely hard problem; first try one concrete next step. Do not use pause_goal as a softer substitute for update_goal=complete \u2014 if the objective is achieved, complete it; if it is not, do not complete it.",
			"Never silently invent a workaround, fake completion, or quietly redefine the objective. Pause and report instead.",
			"Always pass a concrete one-sentence reason. When you know how the user can unblock you, pass suggestedAction (e.g. 'Set FOO_API_KEY env var and /goal-resume', or 'Use /goal-tweak to insert a precondition step before step 3').",
			"After pause_goal returns, stop. Do not call other tools in the same turn.",
			"For sisyphus goals: if any step is unclear, blocked, fails, or seems wrong, pause_goal is the correct action \u2014 do not skip the step or invent a workaround.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "One-sentence concrete blocker description. Plain language, not an apology." }),
			suggestedAction: Type.Optional(Type.String({ description: "Optional concrete suggestion for how the user can unblock (e.g. command to run, value to provide, /goal-tweak hint)." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			const reason = params.reason.trim();
			if (!reason) throw new Error("pause_goal requires a non-empty reason.");
			const pauseGate = validatePauseGoal({ goal: state.goal, runningGoalId, reason });
			if (!pauseGate.ok) {
				return {
					content: [{ type: "text", text: pauseGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during pause validation.");
			const suggested = params.suggestedAction?.trim() || undefined;

			// Account for any remaining elapsed time before stopping the run.
			accountProgress(ctx, { allowBudgetSteering: false, accountBudgetLimited: true });
			state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
			const next = buildPausedByAgentGoal(state.goal, { reason, suggestedAction: suggested, updatedAt: nowIso() });
			setGoal(next, ctx);
			resetAutoContinueCap(next.id);
			// C9 fix: mark turn-stopped so subsequent in-turn tool calls are blocked.
			// This is the schema-level closure of "agent kept writing files after pause_goal".
			turnStoppedFor = state.goal.id;

			const suggestionLine = suggested ? `\nSuggested: ${truncateText(suggested, 160)}` : "";
			ctx.ui.notify(
				`Goal paused by agent.\nReason: ${truncateText(reason, 200)}${suggestionLine}\n\nUse /goal-resume to continue, /goal-tweak to revise, or /goal-clear to abandon.`,
				"warning",
			);
			return {
				content: [{
					type: "text",
					text: `Goal paused. Reason: ${reason}${suggested ? `\nSuggested: ${suggested}` : ""}\nWaiting for user to /goal-resume, /goal-tweak, or /goal-clear. Stop now; do not start another tool call.`,
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "pause_goal ") + theme.fg("warning", truncateText(args?.reason ?? "", 80)), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: ABORT_GOAL_TOOL_NAME,
		label: "Abort Goal",
		description: "Abort the current active, budget-limited, or paused pi goal and archive it without marking it complete.",
		promptSnippet: "Abort the current pi goal only when the user asks to abandon it or the objective is obsolete/impossible.",
		promptGuidelines: [
			"Use abort_goal only when the user explicitly asks to abandon/cancel the current goal, or when the goal is impossible, obsolete, or unsafe to continue and should not be marked complete.",
			"Do not use abort_goal as a substitute for update_goal(status=complete). If the objective is achieved, complete it instead.",
			"Do not use abort_goal for ordinary blockers that the user can resolve; use pause_goal({reason, suggestedAction?}) for that case.",
			"Always pass a concrete one-sentence reason. After abort_goal returns, stop and do not call other tools in the same turn.",
		],
		parameters: Type.Object({
			reason: Type.String({ description: "One-sentence reason for abandoning the current goal. Plain language, not an apology." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			const reason = params.reason.trim();
			if (!reason) throw new Error("abort_goal requires a non-empty reason.");
			const abortGate = validateGoalAbort({ goal: state.goal, runningGoalId, reason });
			if (!abortGate.ok) {
				return {
					content: [{ type: "text", text: abortGate.message }],
					details: goalDetails(state.goal),
				};
			}
			if (!state.goal) throw new Error("Goal disappeared during abort validation.");
			const abortedGoalId = state.goal.id;

			// Account for any remaining elapsed time before abandoning the run.
			accountProgress(ctx, { allowBudgetSteering: false, accountBudgetLimited: true });
			state.goal = mergeGoalPromptFromDisk(ctx, state.goal);
			state.goal = buildAbortedByAgentGoal(state.goal, { reason, updatedAt: nowIso() });
			const archived = archiveCurrentGoal(ctx, "agent");
			resetAutoContinueCap(abortedGoalId);
			setGoal(null, ctx, true, "aborted");
			turnStoppedFor = abortedGoalId;

			const archiveLine = archived?.archivedPath ? `\nArchive: ${archived.archivedPath}` : "";
			ctx.ui.notify(
				`Goal aborted by agent.\nReason: ${truncateText(reason, 200)}${archiveLine}`,
				"warning",
			);
			return {
				content: [{
					type: "text",
					text: `Goal aborted. Reason: ${reason}${archiveLine}\nThe goal has been archived and cleared. Stop now; do not start another tool call.`,
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "abort_goal ") + theme.fg("warning", truncateText(args?.reason ?? "", 80)), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: SISYPHUS_STEP_TOOL_NAME,
		label: "Sisyphus Step Complete (Legacy)",
		description: "Legacy compatibility tool. Current Sisyphus mode is a prompt/criteria style and no longer uses schema-tracked step completion.",
		promptSnippet: "Legacy no-op: Sisyphus no longer requires step_complete.",
		promptGuidelines: [
			"Do not call this in normal operation. Sisyphus mode shares the normal goal lifecycle and completion gate.",
			"Complete the goal with update_goal(status=complete) only when the full objective is actually satisfied.",
		],
		parameters: Type.Object({
			stepIndex: Type.Integer({ minimum: 1, description: "Legacy step index. Ignored." }),
			evidence: Type.String({ description: "Legacy evidence text. Ignored by the schema." }),
			verifyCommand: Type.Optional(Type.String({ description: "Legacy field. Not executed." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, _params, _signal, _onUpdate, _ctx) {
			return {
				content: [{ type: "text", text: "step_complete is no longer required. Sisyphus is now a prompt/criteria style that uses the normal goal lifecycle. Continue working from the objective, or call update_goal(status=complete) only when the full objective is satisfied." }],
				details: goalDetails(state.goal),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "step_complete legacy ") + theme.fg("muted", `#${args?.stepIndex ?? "?"}`), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: TWEAK_APPLY_TOOL_NAME,
		label: "Apply Goal Tweak",
		description: "Atomically apply a /goal-tweak revision to the active goal. The ONLY way to modify an active goal's objective. Only available during a /goal-tweak drafting flow.",
		promptSnippet: "Apply the revised goal objective produced by a /goal-tweak drafting interview.",
		promptGuidelines: [
			"Only call apply_goal_tweak inside a /goal-tweak drafting flow (the prompt makes that explicit). It is rejected at any other time.",
			"newObjective must be the FULL revised objective text, formatted the same way as the original (=== Goal === or === Sisyphus Goal === block). Do NOT pass a diff or partial patch; pass the whole new objective.",
			"For Sisyphus goals: preserve the Sisyphus style and ordered-plan wording unless the user explicitly asks to remove it.",
			"changeSummary is a one-sentence description of WHAT changed (for the activity log and pause messages).",
			"Do NOT use write/edit/bash to modify the active goal file directly. apply_goal_tweak is the only sanctioned channel.",
			"After apply_goal_tweak returns, stop. Do not begin new task work in the same turn. The system will queue the next continuation.",
		],
		parameters: Type.Object({
			newObjective: Type.String({ description: "The complete revised objective text. For Sisyphus goals, preserve the Sisyphus style unless the user explicitly changes it." }),
			changeSummary: Type.String({ description: "One-sentence description of what was changed (used in UI notification and tweak log)." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			reconcileFocusedGoalFromDisk(ctx);
			if (!state.goal) {
				return {
					content: [{ type: "text", text: "No goal is set; apply_goal_tweak is a no-op." }],
					details: goalDetails(state.goal),
				};
			}
			if (tweakDraftingFor !== state.goal.id) {
				return {
					content: [{
						type: "text",
						text: "apply_goal_tweak REJECTED: no /goal-tweak drafting flow is active for this goal. " +
							"This tool can only be called during a /goal-tweak drafting interview that the user initiated. " +
							"If you want to change the goal, ask the user to run /goal-tweak.",
					}],
					details: goalDetails(state.goal),
				};
			}
			if (state.goal.status !== "active" && state.goal.status !== "budgetLimited" && state.goal.status !== "paused") {
				return {
					content: [{ type: "text", text: `Goal is ${statusLabel(state.goal)}; cannot apply a tweak.` }],
					details: goalDetails(state.goal),
				};
			}
			const newObjective = params.newObjective.trim();
			if (!newObjective) throw new Error("apply_goal_tweak requires a non-empty newObjective.");
			const changeSummary = params.changeSummary.trim();
			if (!changeSummary) throw new Error("apply_goal_tweak requires a non-empty changeSummary.");
			const next: GoalRecord = {
				...state.goal,
				objective: newObjective,
				updatedAt: nowIso(),
				// Clear any prior agent pause reason — the user has redefined the work.
				pauseReason: undefined,
				pauseSuggestedAction: undefined,
			};
			// IMPORTANT: bypass setGoal() / persist() here. persist() calls
			// syncGoalPromptFromDisk() which would RE-READ the stale objective
			// from the still-old goal file on disk and clobber our new objective
			// before writing. apply_goal_tweak is the authoritative source for
			// objective changes — the disk is downstream, not upstream. Do the
			// minimal state update manually:
			//   1) write the new record to disk authoritatively
			//   2) update in-memory `goal` to the canonical post-write record
			//   3) append the state entry and re-sync tools
			//   4) clear the tweak drafting gate so apply_goal_tweak can't be re-used
			state.goal = writeActiveGoalFile(ctx, next);
			pi.appendEntry(STATE_ENTRY, goalDetails(state.goal));
			tweakDraftingFor = null;
			// Reset autoContinue counter — plan changed, agent gets a fresh chain.
			resetAutoContinueCap(state.goal.id);
			// C9 fix: mark turn-stopped so subsequent in-turn tool calls are blocked.
			turnStoppedFor = state.goal.id;
			syncGoalTools();
			updateUI(ctx);
			ctx.ui.notify(`Goal tweaked: ${truncateText(changeSummary, 160)}`, "info");
			return {
				content: [{
					type: "text",
					text: `Goal tweak applied. ${changeSummary}\nStop now; the next continuation will arrive automatically if the goal is active.`,
				}],
				details: goalDetails(state.goal),
				terminate: true,
			};
		},
		renderCall(args, theme) {
			const summary = typeof args?.changeSummary === "string" ? truncateText(args.changeSummary, 80) : "";
			return new Text(theme.fg("toolTitle", "apply_goal_tweak ") + theme.fg("muted", summary), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	syncGoalTools();

	pi.on("context", async (event): Promise<{ messages: typeof event.messages } | undefined> => {
		let changed = false;
		const latestGoalEventIndex = new Map<string, number>();
		event.messages.forEach((message, index) => {
			const queuedGoalId = goalEventMessageId(message as { customType?: string; details?: unknown; content?: unknown });
			if (queuedGoalId) latestGoalEventIndex.set(queuedGoalId, index);
		});

		const messages = event.messages.map((message, index) => {
			const candidate = message as { customType?: string; details?: unknown; content?: unknown };
			const queuedGoalId = goalEventMessageId(candidate);
			if (!queuedGoalId) return message;
			if (
				state.goal?.id === queuedGoalId
				&& (state.goal.status === "active" || state.goal.status === "budgetLimited")
				&& state.goal.autoContinue
				&& latestGoalEventIndex.get(queuedGoalId) === index
			) return message;
			changed = true;
			const details = asRecord(candidate.details) ?? {};
			return {
				...message,
				content: staleContinuationPrompt(queuedGoalId, state.goal),
				display: false,
				details: {
					...details,
					kind: "stale",
					goalId: queuedGoalId,
					currentGoalId: state.goal?.id ?? null,
					currentStatus: state.goal?.status ?? null,
				},
			} as typeof message;
		});
		return changed ? { messages } : undefined;
	});

	pi.on("turn_start", async (_event, ctx) => {
		// Per-turn flag resets (#4 + C9 fix).
		goalWorkToolCalledThisTurn = false;
		turnStoppedFor = null;
		beginAccounting();
		if (draftingFor === null && tweakDraftingFor === null && state.goal?.status === "active" && state.goal.autoContinue) {
			if (pauseForAutoContinueCap(ctx)) {
				try {
					ctx.abort?.();
				} catch {}
				return;
			}
			autoContinueTurnsByGoalId.set(state.goal.id, (autoContinueTurnsByGoalId.get(state.goal.id) ?? 0) + 1);
		}
		updateUI(ctx);
	});

	// #4 + C9 fix + Phase 5 C3: gate in-turn tool calls based on lifecycle state.
	pi.on("tool_call", async (event, ctx) => {
		// Post-stop in-turn block (C9 0ad8 fix): after pause_goal / abort_goal /
		// update_goal=complete / apply_goal_tweak fires in this turn, block all subsequent tool calls except
		// read-only inspection. Forces the agent to yield the turn instead of "fixing"
		// the situation by creating extra files etc.
		if (turnStoppedFor !== null && !POST_STOP_ALLOWED_TOOL_SET.has(event.toolName)) {
			return {
				block: true,
				reason: `The goal was already stopped earlier in this turn (goalId=${turnStoppedFor}). ` +
					`Do not call more tools; end the turn with a brief summary and yield to the user.`,
			};
		}
		if (draftingFor === null && tweakDraftingFor === null && state.goal?.status === "active") {
			if (event.toolName === PROPOSE_DRAFT_TOOL_NAME || event.toolName === QUESTION_TOOL_NAME || event.toolName === QUESTIONNAIRE_TOOL_NAME) {
				syncGoalTools();
				return {
					block: true,
					reason: `An active goal is already confirmed (goalId=${state.goal.id}). Do not keep drafting or asking drafting questions. Use write/read/bash/edit to do the concrete work, then update_goal when verified.`,
				};
			}
			if (event.toolName === "get_goal") {
				const prior = activeGetGoalTurnsByGoalId.get(state.goal.id) ?? 0;
				activeGetGoalTurnsByGoalId.set(state.goal.id, prior + 1);
				if (prior >= 1) {
					syncGoalTools();
					return {
						block: true,
						reason: `You already inspected the active goal (goalId=${state.goal.id}). Stop querying get_goal. Use write/read/bash/edit now to do the concrete work, then update_goal or pause_goal based on evidence.`,
					};
				}
			}
		}
		// Phase 5 C3: drafting whitelist. During /goal-set, /goal-sisyphus, or /goal-tweak
		// drafting, block all work tools (bash/write/edit/read/grep/find/ls/step_complete/...)
		// except the dedicated drafting tools. Drafting is a CONVERSATION;
		// reconnaissance is forbidden. This is the schema-level closure of the
		// "agent calls bash during drafting to look at the filesystem" failure mode
		// the drafting prompt already prohibits in language.
		const draftingGate = evaluateDraftingToolGate({
			toolName: event.toolName,
			draftingFocus: draftingFor?.focus ?? null,
			tweakDraftingGoalId: tweakDraftingFor,
			activeGoalId: state.goal?.id ?? null,
			proposeToolName: PROPOSE_DRAFT_TOOL_NAME,
			tweakApplyToolName: TWEAK_APPLY_TOOL_NAME,
		});
		if (draftingGate.block) return draftingGate;
		if (draftingFor && isQuestionLikeToolName(event.toolName)) {
			const eventRecord = asRecord(event);
			const eventArgs = asRecord(eventRecord?.args);
			const questionText = String(eventArgs?.question ?? eventArgs?.questions ?? "");
			const shouldCount = ctx.hasUI || isHeadlessQuestionSufficientForDraft({ topic: draftingFor.originalTopic, questionText });
			if (shouldCount) draftingFor = { ...draftingFor, questionsAsked: draftingFor.questionsAsked + 1 };
			syncGoalTools();
		}
		// Track for #4 empty-turn gate.
		if (isMeaningfulProgressToolCall(event.toolName, asRecord(event)?.args)) {
			if (state.goal?.id) activeGetGoalTurnsByGoalId.delete(state.goal.id);
			goalWorkToolCalledThisTurn = true;
		} else if (state.goal?.status === "active" && state.goal.autoContinue && event.toolName !== "get_goal") {
			// A blocked non-progress tool (for example repeated get_goal or stale
			// propose_goal_draft) should not create an infinite retry chain.
			turnStoppedFor = state.goal.id;
		}
		return;
	});

	pi.on("tool_execution_end", async (_event, ctx) => {
		accountProgress(ctx, { allowBudgetSteering: true, accountBudgetLimited: true });
	});

	pi.on("turn_end", async (event, ctx) => {
		const message = event.message as AssistantMessageLike;
		if (draftingFor !== null || tweakDraftingFor !== null) {
			if (
				draftingFor !== null
				&& !isAbortedAssistantMessage(message)
				&& !isToolUseAssistantMessage(message)
				&& (draftingFor.questionsAsked > 0 || isHeadlessQuestionSufficientForDraft({ topic: draftingFor.originalTopic, questionText: "" }))
			) {
				queueDraftingNudge(ctx, draftingFor);
			}
			return;
		}
		const tokens = assistantTurnTokens(message);
		accountProgress(ctx, { allowBudgetSteering: true, completedTurnTokens: tokens });

		if (isAbortedAssistantMessage(message)) {
			pauseActiveGoal(ctx);
			return;
		}
		refreshGoalDisplayFromDisk(ctx);
		// If the assistant ended a turn without queuing more tool calls, push a continuation right away.
		// #4: only queue if some real work was done this turn — otherwise the model is
		// just chatting and we should not keep firing turns (would burn budget on noise).
		if (
			!isToolUseAssistantMessage(message)
			&& state.goal?.status === "active"
			&& state.goal.autoContinue
			&& goalWorkToolCalledThisTurn
		) {
			queueContinuation(ctx);
		}
	});

	pi.on("message_end", async (event, ctx) => {
		if (isAbortedAssistantMessage(event.message)) pauseActiveGoal(ctx);
		const raw = asRecord(event.message);
		if (raw?.role === "custom" && raw.customType === GOAL_EVENT_ENTRY && raw.display !== false) {
			return { message: { ...event.message, display: false } as typeof event.message };
		}
	});

	pi.on("session_start", async (event, ctx) => {
		loadState(ctx);
		syncTerminalInputPause(ctx);
		if (event.reason === "resume" && !state.goal && openGoals().length > 1 && ctx.hasUI) {
			await focusGoalCommand(ctx);
		}
		// Codex behavior: prompt before reactivating a paused goal on resume.
		if (event.reason === "resume" && state.goal?.status === "paused" && ctx.hasUI) {
			const current = state.goal;
			const shouldResume = await ctx.ui.confirm("Resume paused goal?", `Goal: ${current.objective}`);
			if (shouldResume) {
				setGoal({ ...current, status: "active", autoContinue: true, stopReason: undefined, pauseReason: undefined, pauseSuggestedAction: undefined }, ctx);
			}
		}
		beginAccounting();
		queueContinuation(ctx, true);
	});

	pi.on("session_before_compact", async (_event, ctx) => {
		accountProgress(ctx, { allowBudgetSteering: false, accountBudgetLimited: true });
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (draftingFor !== null || tweakDraftingFor !== null) return;
		if (state.goal) persist(ctx);
		beginAccounting();
		// Arm a generic post-compaction reminder for the next agent turn.
		if (shouldArmPostCompactReminder(state.goal)) {
			postCompactReminderPending = true;
		}
		queueContinuation(ctx, true);
	});

	pi.on("session_tree", async (_event, ctx) => {
		loadState(ctx);
		syncTerminalInputPause(ctx);
		beginAccounting();
		queueContinuation(ctx, true);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		syncGoalTools();
		const currentSystemPrompt = () => ctx.getSystemPrompt?.() || event.systemPrompt;
		const incomingGoalId = extractGoalIdFromInjectedMessage(event.prompt ?? "");
		const incomingDraftId = extractDraftIdFromInjectedMessage(event.prompt ?? "");

		const draftIdentity = validateDraftPromptIdentity({ incomingDraftId, activeDraftId: draftingFor?.draftId ?? null });
		if (draftIdentity.block) {
			try {
				ctx.abort?.();
			} catch {}
			return { systemPrompt: `${currentSystemPrompt()}\n\n${draftIdentity.reason}` };
		}

		if (draftingFor !== null || tweakDraftingFor !== null) {
			clearContinuationState();
			clearActiveAccounting();
			runningGoalId = null;
			return { systemPrompt: currentSystemPrompt() };
		}

		// If this turn was triggered by a hidden goal checkpoint that no longer
		// matches the active goal, abort the whole turn instead of letting the
		// model act on a stale instruction.
		if (incomingGoalId !== null) {
			clearContinuationState();
			if (!state.goal || state.goal.id !== incomingGoalId || (state.goal.status !== "active" && state.goal.status !== "budgetLimited") || !state.goal.autoContinue) {
				try {
					ctx.abort?.();
				} catch {}
				updateUI(ctx);
				return {
					systemPrompt: `${currentSystemPrompt()}\n\n${staleContinuationPrompt(incomingGoalId, state.goal)}`,
				};
			}
		} else {
			// A user-driven turn — clear any queued continuation so we don't
			// double-fire after the user's own message returns. Also reset the
			// autoContinue hard-cap counter so the user always gets a fresh chain.
			clearContinuationState();
			resetAutoContinueCap(state.goal?.id);
		}

		if (!state.goal) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) {
				return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			}
			return;
		}
		reconcileFocusedGoalFromDisk(ctx);
		if (!state.goal) {
			runningGoalId = null;
			const openCount = openGoals().length;
			if (openCount > 0) return { systemPrompt: `${currentSystemPrompt()}\n\n${unfocusedOpenGoalsPrompt(openCount)}` };
			return;
		}
		runningGoalId = state.goal.status === "active" || state.goal.status === "budgetLimited" ? state.goal.id : null;
		if (state.goal.status === "complete") return;
		if (state.goal.status === "paused") {
			const current = state.goal;
			const pauseExtras: string[] = [];
			if (current.stopReason === "agent") {
				pauseExtras.push("");
				pauseExtras.push(`Pause reason (you set this in a prior turn via pause_goal): ${current.pauseReason ?? "(unknown)"}`);
				if (current.pauseSuggestedAction) pauseExtras.push(`You suggested: ${current.pauseSuggestedAction}`);
			}
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL PAUSED goalId=${current.id}]\n${untrustedObjectiveBlock(current)}${pauseExtras.join("\n")}\n\nThe goal is paused. Do not autonomously continue substantive work unless the user resumes it with /goal-resume. If the user explicitly asks to finish or abandon the paused goal, or the objective is already satisfied based on available evidence, you may call update_goal(status=complete) or abort_goal without resuming. Do not call pause_goal again.`,
			};
		}
		if (state.goal.status === "budgetLimited") {
			const current = state.goal;
			return {
				systemPrompt: `${currentSystemPrompt()}\n\n[PI GOAL BUDGET LIMIT goalId=${current.id}]\n${untrustedObjectiveBlock(current)}\n\n${budgetBlock(current)}\n\nThe goal is budget_limited. Do not start new substantive work for it. Summarize useful progress, identify remaining work, and leave the user a clear next step. The user can run /goal-budget <tokens|none> to raise or remove the budget and resume with a fresh auto-continue cap.`,
			};
		}
		let prompt = goalPrompt(state.goal);
		if (shouldInjectPostCompactReminder({ pending: postCompactReminderPending, goal: state.goal })) {
			postCompactReminderPending = false;
			prompt = `${prompt}\n\n[POST-COMPACTION RESYNC goalId=${state.goal.id}]\nThe conversation was just compacted. Re-read the objective and continue from the actual artifacts/state; do not rely on memory of the prior chat.`;
		}
		return { systemPrompt: `${currentSystemPrompt()}\n\n${prompt}` };
	});

	pi.on("agent_end", async (event, ctx) => {
		if (draftingFor !== null || tweakDraftingFor !== null) return;
		const endedGoalId = runningGoalId;
		runningGoalId = null;

		// Account for any tokens from aborted in-flight assistant messages so
		// they are not silently lost (but charge them to the original goal).
		const abortedTokens = event.messages
			.filter(isAbortedAssistantMessage)
			.reduce((sum, message) => sum + assistantTurnTokens(message), 0);
		if (abortedTokens > 0 && endedGoalId && state.goal?.id === endedGoalId) {
			accountProgress(ctx, { allowBudgetSteering: false, completedTurnTokens: abortedTokens, accountBudgetLimited: true });
		}

		continuationQueuedFor = null;
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue) return;
		if (endedGoalId && state.goal.id !== endedGoalId) return;
		if (!reconcileFocusedGoalFromDisk(ctx)) return;
		if (hasAbortedAssistantMessage(event.messages) || ctx.signal?.aborted) {
			pauseActiveGoal(ctx);
			return;
		}
		persist(ctx);
		updateUI(ctx);
		queueContinuation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		accountProgress(ctx, { allowBudgetSteering: false, accountBudgetLimited: true });
		clearContinuationTimer();
		stopStatusRefresh();
		terminalInputUnsubscribe?.();
		terminalInputUnsubscribe = null;
		if (state.goal) persist(ctx);
	});
}
