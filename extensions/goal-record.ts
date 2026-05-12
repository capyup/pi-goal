export type GoalStatus = "active" | "paused" | "budgetLimited" | "complete";
export type StopReason = "user" | "agent";
export type GoalEventKind = "checkpoint" | "stale" | "budget_limit" | "drafting";
export type DraftingFocus = "goal" | "sisyphus";
export type GoalFocusReason = "created" | "selected" | "resumed" | "completed" | "cleared" | "aborted" | "migrated";

export interface GoalUsage {
	tokensUsed: number;
	activeSeconds: number;
}

export interface GoalRecord {
	id: string;
	objective: string;
	status: GoalStatus;
	autoContinue: boolean;
	tokenBudget: number | null;
	usage: GoalUsage;
	sisyphus: boolean;
	createdAt: string;
	updatedAt: string;
	activePath?: string;
	archivedPath?: string;
	stopReason?: StopReason;
	// Set by the agent's pause_goal tool. Cleared when the goal becomes active again.
	pauseReason?: string;
	pauseSuggestedAction?: string;
}

export interface GoalStateEntry {
	version: 3;
	goal: GoalRecord | null;
}

export interface GoalFocusEntry {
	version: 1;
	focusedGoalId: string | null;
	reason: GoalFocusReason;
}

export interface GoalEventDetails {
	kind: GoalEventKind;
	goalId: string;
	status?: GoalStatus;
	objective?: string;
	timestamp?: number;
	currentGoalId?: string | null;
	currentStatus?: GoalStatus | null;
	focus?: DraftingFocus;
}

export interface GoalCreationConfig {
	objective: string;
	autoContinue: boolean;
	tokenBudget: number | null;
	sisyphus: boolean;
}

export interface AssistantUsage {
	input?: number;
	output?: number;
}

export interface AssistantMessageLike {
	role?: string;
	stopReason?: string;
	usage?: AssistantUsage;
}

export function nowIso(now = Date.now()): string {
	return new Date(now).toISOString();
}

export function safeIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "goal";
}

export function newGoalId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function normalizeRelPath(relPath: string): string {
	return relPath.split(/[\\/]+/).join("/");
}

export function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

export function emptyUsage(): GoalUsage {
	return { tokensUsed: 0, activeSeconds: 0 };
}

export function cloneGoal(goal: GoalRecord): GoalRecord {
	return { ...goal, usage: { ...goal.usage } };
}

export function goalFocusDetails(focusedGoalId: string | null, reason: GoalFocusReason): GoalFocusEntry {
	return {
		version: 1,
		focusedGoalId: focusedGoalId ? safeIdPart(focusedGoalId) : null,
		reason,
	};
}

export function normalizeGoalFocusEntry(value: unknown): GoalFocusEntry | null {
	const raw = asRecord(value);
	if (!raw || raw.version !== 1) return null;
	const focusedGoalId = typeof raw.focusedGoalId === "string" && raw.focusedGoalId.trim()
		? safeIdPart(raw.focusedGoalId)
		: null;
	const reason: GoalFocusReason =
		raw.reason === "created" || raw.reason === "selected" || raw.reason === "resumed" || raw.reason === "completed" || raw.reason === "cleared" || raw.reason === "aborted" || raw.reason === "migrated"
			? raw.reason
			: "selected";
	return { version: 1, focusedGoalId, reason };
}

export function createGoal(config: GoalCreationConfig, now = Date.now()): GoalRecord {
	const timestamp = nowIso(now);
	return {
		id: newGoalId(),
		objective: config.objective,
		status: "active",
		autoContinue: config.autoContinue,
		tokenBudget: config.tokenBudget,
		usage: emptyUsage(),
		sisyphus: config.sisyphus,
		createdAt: timestamp,
		updatedAt: timestamp,
	};
}

export function normalizeUsage(value: unknown): GoalUsage {
	const raw = asRecord(value);
	if (!raw) return emptyUsage();
	const tokensUsed = typeof raw.tokensUsed === "number" && Number.isFinite(raw.tokensUsed) ? Math.max(0, Math.floor(raw.tokensUsed)) : 0;
	const activeSeconds = typeof raw.activeSeconds === "number" && Number.isFinite(raw.activeSeconds) ? Math.max(0, Math.floor(raw.activeSeconds)) : 0;
	return { tokensUsed, activeSeconds };
}

export function normalizeGoalRecord(value: unknown): GoalRecord | null {
	const raw = asRecord(value);
	if (!raw) return null;
	const objective = typeof raw.objective === "string" ? raw.objective.trim() : "";
	if (!objective) return null;

	const timestamp = nowIso();
	const rawStatus = raw.status;
	let status: GoalStatus =
		rawStatus === "complete"
			? "complete"
			: rawStatus === "paused"
				? "paused"
				: rawStatus === "budgetLimited" || rawStatus === "budget_limited"
					? "budgetLimited"
					: "active";
	const autoContinue = typeof raw.autoContinue === "boolean" ? raw.autoContinue : true;
	const tokenBudget =
		raw.tokenBudget === null
			? null
			: typeof raw.tokenBudget === "number" && Number.isFinite(raw.tokenBudget) && raw.tokenBudget > 0
				? Math.floor(raw.tokenBudget)
				: null;
	const usage = normalizeUsage(raw.usage);
	const sisyphus = raw.sisyphus === true;

	// Treat paused-but-auto as active (legacy migration) but keep budgetLimited if still over budget.
	if (status === "paused" && autoContinue && (tokenBudget === null || usage.tokensUsed < tokenBudget)) {
		status = "active";
	}
	if (status === "active" && tokenBudget !== null && usage.tokensUsed >= tokenBudget) {
		status = "budgetLimited";
	}

	return {
		id: typeof raw.id === "string" && raw.id ? safeIdPart(raw.id) : newGoalId(),
		objective,
		status,
		autoContinue,
		tokenBudget,
		usage,
		sisyphus,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : timestamp,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : timestamp,
		activePath: typeof raw.activePath === "string" ? raw.activePath : undefined,
		archivedPath: typeof raw.archivedPath === "string" ? raw.archivedPath : undefined,
		stopReason: raw.stopReason === "agent" || raw.stopReason === "user" ? raw.stopReason : undefined,
		pauseReason: typeof raw.pauseReason === "string" && raw.pauseReason.trim() ? raw.pauseReason : undefined,
		pauseSuggestedAction: typeof raw.pauseSuggestedAction === "string" && raw.pauseSuggestedAction.trim() ? raw.pauseSuggestedAction : undefined,
	};
}
