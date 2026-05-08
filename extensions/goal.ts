import { StringEnum, Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as path from "node:path";

const STATE_ENTRY = "pi-goal-state";
const COMPLETE_STATUS = "complete";
const GOALS_DIR = ".pi/goals";
const ARCHIVED_GOALS_DIR = ".pi/goals/archived";
const CONTINUATION_IDLE_RETRY_MS = 250;

type GoalStatus = "active" | "paused" | "budget_limited" | "complete";
type StopReason = "token_budget" | "max_turns" | "user" | "agent";

interface GoalRecord {
	id: string;
	objective: string;
	status: GoalStatus;
	tokenBudget?: number;
	tokensUsed: number;
	timeUsedSeconds: number;
	turns: number;
	maxTurns?: number;
	autoContinue: boolean;
	createdAt: string;
	updatedAt: string;
	activeStartedAt?: string;
	stopReason?: StopReason;
	activePath?: string;
	archivedPath?: string;
}

interface GoalStateEntry {
	version: 1;
	goal: GoalRecord | null;
}

interface ParsedGoalArgs {
	objective: string;
	tokenBudget?: number;
	maxTurns?: number;
	autoContinue: boolean;
}

function nowIso(now = Date.now()): string {
	return new Date(now).toISOString();
}

function safeIdPart(value: string): string {
	return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 80) || "goal";
}

function newGoalId(): string {
	return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function cloneGoal(goal: GoalRecord): GoalRecord {
	return { ...goal };
}

function currentElapsedSeconds(goal: GoalRecord, now = Date.now()): number {
	if (goal.status !== "active" || !goal.activeStartedAt) return goal.timeUsedSeconds;
	const started = Date.parse(goal.activeStartedAt);
	if (!Number.isFinite(started)) return goal.timeUsedSeconds;
	const extra = Math.max(0, Math.floor((now - started) / 1000));
	return goal.timeUsedSeconds + extra;
}

function snapshotGoal(goal: GoalRecord, now = Date.now()): GoalRecord {
	return {
		...goal,
		timeUsedSeconds: currentElapsedSeconds(goal, now),
	};
}

function materializeGoal(goal: GoalRecord, now = Date.now()): GoalRecord {
	const next = snapshotGoal(goal, now);
	next.updatedAt = nowIso(now);
	if (next.status === "active") {
		next.activeStartedAt = nowIso(now);
	} else {
		delete next.activeStartedAt;
	}
	return next;
}

function suspendActiveClock(goal: GoalRecord, now = Date.now()): GoalRecord {
	const next = snapshotGoal(goal, now);
	next.updatedAt = nowIso(now);
	delete next.activeStartedAt;
	return next;
}

function resumeActiveClock(goal: GoalRecord, now = Date.now()): GoalRecord {
	if (goal.status !== "active" || goal.activeStartedAt) return goal;
	return { ...goal, activeStartedAt: nowIso(now), updatedAt: nowIso(now) };
}

function formatDuration(seconds: number): string {
	const safe = Math.max(0, Math.floor(seconds));
	const hours = Math.floor(safe / 3600);
	const minutes = Math.floor((safe % 3600) / 60);
	const secs = safe % 60;
	if (hours > 0) return `${hours}h ${minutes}m`;
	if (minutes > 0) return `${minutes}m ${secs}s`;
	return `${secs}s`;
}

function formatTokens(tokens: number): string {
	const safe = Math.max(0, Math.floor(tokens));
	if (safe >= 1_000_000) return `${(safe / 1_000_000).toFixed(safe >= 10_000_000 ? 0 : 1)}M`;
	if (safe >= 1_000) return `${(safe / 1_000).toFixed(safe >= 10_000 ? 0 : 1)}K`;
	return String(safe);
}

function parseBudget(value: string): number | undefined {
	const match = value.trim().match(/^(\d+(?:\.\d+)?)([kKmM])?$/);
	if (!match) return undefined;
	const n = Number(match[1]);
	if (!Number.isFinite(n) || n <= 0) return undefined;
	const suffix = match[2]?.toLowerCase();
	const multiplier = suffix === "m" ? 1_000_000 : suffix === "k" ? 1_000 : 1;
	return Math.floor(n * multiplier);
}

function parsePositiveInteger(value: string): number | undefined {
	const parsed = Number(value.trim());
	if (!Number.isInteger(parsed) || parsed < 0) return undefined;
	return parsed;
}

function tokenizeArgs(raw: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let quote: '"' | "'" | null = null;
	let escaped = false;

	for (const char of raw) {
		if (escaped) {
			current += char;
			escaped = false;
			continue;
		}
		if (char === "\\") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (char === quote) {
				quote = null;
			} else {
				current += char;
			}
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (current) {
				tokens.push(current);
				current = "";
			}
			continue;
		}
		current += char;
	}
	if (escaped) current += "\\";
	if (current) tokens.push(current);
	return tokens;
}

function parseGoalArgs(raw: string): ParsedGoalArgs | { error: string } {
	const tokens = tokenizeArgs(raw.trim());
	let tokenBudget: number | undefined;
	let maxTurns: number | undefined;
	let autoContinue = true;
	let index = 0;

	for (; index < tokens.length; index++) {
		const token = tokens[index] ?? "";
		const next = tokens[index + 1];
		if (token === "--tokens" || token === "--token-budget") {
			if (!next) return { error: `Missing value for ${token}.` };
			const parsed = parseBudget(next);
			if (!parsed) return { error: `Invalid token budget: ${next}. Use values like 50000, 50k, or 1.5m.` };
			tokenBudget = parsed;
			index++;
			continue;
		}
		if (token.startsWith("--tokens=")) {
			const parsed = parseBudget(token.slice("--tokens=".length));
			if (!parsed) return { error: `Invalid token budget: ${token}.` };
			tokenBudget = parsed;
			continue;
		}
		if (token === "--max-turns") {
			if (!next) return { error: "Missing value for --max-turns." };
			const parsed = parsePositiveInteger(next);
			if (parsed === undefined) return { error: `Invalid max turns: ${next}.` };
			maxTurns = parsed === 0 ? undefined : parsed;
			index++;
			continue;
		}
		if (token.startsWith("--max-turns=")) {
			const parsed = parsePositiveInteger(token.slice("--max-turns=".length));
			if (parsed === undefined) return { error: `Invalid max turns: ${token}.` };
			maxTurns = parsed === 0 ? undefined : parsed;
			continue;
		}
		if (token === "--no-auto" || token === "--no-start") {
			autoContinue = false;
			continue;
		}
		if (token === "--auto" || token === "--start") {
			autoContinue = true;
			continue;
		}
		break;
	}

	const objective = tokens.slice(index).join(" ").trim();
	if (!objective) return { error: "Goal objective must not be empty." };
	return { objective, tokenBudget, maxTurns, autoContinue };
}

function createGoal(args: ParsedGoalArgs, now = Date.now()): GoalRecord {
	const timestamp = nowIso(now);
	return {
		id: newGoalId(),
		objective: args.objective,
		status: "active",
		tokenBudget: args.tokenBudget,
		tokensUsed: 0,
		timeUsedSeconds: 0,
		turns: 0,
		maxTurns: args.maxTurns,
		autoContinue: args.autoContinue,
		createdAt: timestamp,
		updatedAt: timestamp,
		activeStartedAt: timestamp,
	};
}

function statusLabel(status: GoalStatus): string {
	switch (status) {
		case "active":
			return "active";
		case "paused":
			return "paused";
		case "budget_limited":
			return "budget limited";
		case "complete":
			return "complete";
	}
}

function truncateText(value: string, max = 120): string {
	const oneLine = value.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 3)}...` : oneLine;
}

function oneLineSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set.";
	const g = snapshotGoal(goal);
	const parts = [statusLabel(g.status), `${formatDuration(g.timeUsedSeconds)}`, `${formatTokens(g.tokensUsed)} tokens`];
	if (g.tokenBudget) parts.push(`${formatTokens(Math.max(0, g.tokenBudget - g.tokensUsed))} tokens left`);
	if (g.maxTurns) parts.push(`${g.turns}/${g.maxTurns} turns`);
	return `${parts.join(" | ")} - ${truncateText(g.objective)}`;
}

function detailedSummary(goal: GoalRecord | null): string {
	if (!goal) return "No goal is set. Usage: /goal <objective>";
	const g = snapshotGoal(goal);
	const lines = [
		`Goal: ${g.objective}`,
		`Status: ${statusLabel(g.status)}`,
		`Elapsed: ${formatDuration(g.timeUsedSeconds)}`,
		`Tokens: ${formatTokens(g.tokensUsed)}${g.tokenBudget ? ` / ${formatTokens(g.tokenBudget)}` : ""}`,
		`Turns: ${g.turns}${g.maxTurns ? ` / ${g.maxTurns}` : ""}`,
		`Auto-continue: ${g.autoContinue ? "on" : "off"}`,
	];
	if (g.activePath) lines.push(`File: ${g.activePath}`);
	if (g.archivedPath) lines.push(`Archive: ${g.archivedPath}`);
	if (g.stopReason) lines.push(`Stop reason: ${g.stopReason}`);
	return lines.join("\n");
}

function goalPrompt(goal: GoalRecord): string {
	const g = snapshotGoal(goal);
	const remaining = g.tokenBudget ? Math.max(0, g.tokenBudget - g.tokensUsed) : undefined;
	return `[PI GOAL ACTIVE goalId=${g.id}]\nObjective: ${g.objective}\nStatus: ${statusLabel(g.status)}\nElapsed: ${formatDuration(g.timeUsedSeconds)}\nTokens used: ${formatTokens(g.tokensUsed)}${g.tokenBudget ? ` / ${formatTokens(g.tokenBudget)} (${formatTokens(remaining ?? 0)} remaining)` : ""}\nTurns used: ${g.turns}${g.maxTurns ? ` / ${g.maxTurns}` : ""}\n\nContinue working toward the objective until it is actually achieved. Do not pause for confirmation just because a phase, chapter, file, or checklist item is finished; immediately choose the next concrete action toward the objective. Use get_goal when you need the current state. Call update_goal with status=complete only when no required work remains. If blocked, explain the blocker to the user instead of marking the goal complete. The user may tweak this objective during the run; always follow the latest objective shown here.`;
}

function continuationPrompt(goal: GoalRecord): string {
	const g = snapshotGoal(goal);
	return `[GOAL CONTINUATION goalId=${g.id}]\nContinue working toward the active goal.\n\nObjective:\n${g.objective}\n\nBudget:\n- Elapsed: ${formatDuration(g.timeUsedSeconds)}\n- Tokens used: ${formatTokens(g.tokensUsed)}${g.tokenBudget ? ` / ${formatTokens(g.tokenBudget)}` : ""}\n- Turns used: ${g.turns}${g.maxTurns ? ` / ${g.maxTurns}` : ""}\n\nAvoid repeating work that is already done. Do not pause for confirmation after a partial milestone; if the objective implies a sequence, continue with the next item immediately. Before deciding that the goal is achieved, audit the objective against real evidence in the current project state. If any requirement is missing, incomplete, or unverified, keep working. If the goal is fully achieved, call update_goal with status=complete and then summarize the result. If you are blocked, explain exactly what is blocking progress.`;
}

function timestampForFile(iso = nowIso()): string {
	const date = new Date(iso);
	const safe = Number.isFinite(date.getTime()) ? date : new Date();
	const pad = (value: number, width = 2) => String(value).padStart(width, "0");
	return [
		safe.getFullYear(),
		pad(safe.getMonth() + 1),
		pad(safe.getDate()),
		pad(safe.getHours()),
		pad(safe.getMinutes()),
		pad(safe.getSeconds()),
		pad(Math.floor(safe.getMilliseconds() / 10)),
	].join("");
}

function relativeGoalPath(ctx: ExtensionContext, filePath: string): string {
	return path.relative(ctx.cwd, filePath).split(path.sep).join("/");
}

function safeResolveUnder(ctx: ExtensionContext, rootRel: string, relPath: string): string {
	if (path.isAbsolute(relPath) || relPath.includes("\0")) {
		throw new Error(`Unsafe goal path: ${relPath}`);
	}
	const root = path.resolve(ctx.cwd, rootRel);
	const absolutePath = path.resolve(ctx.cwd, relPath);
	const relative = path.relative(root, absolutePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Goal path escapes ${rootRel}: ${relPath}`);
	}
	return absolutePath;
}

function isSafeRelativeUnder(ctx: ExtensionContext, rootRel: string, relPath: string | undefined): relPath is string {
	if (!relPath) return false;
	try {
		safeResolveUnder(ctx, rootRel, relPath);
		return true;
	} catch {
		return false;
	}
}

function normalizeRelPath(relPath: string): string {
	return relPath.split(/[\\/]+/).join("/");
}

function isDirectChildOf(relPath: string, parentRel: string): boolean {
	return normalizeRelPath(path.posix.dirname(normalizeRelPath(relPath))) === normalizeRelPath(parentRel);
}

function isSafeActivePath(ctx: ExtensionContext, relPath: string | undefined): relPath is string {
	return Boolean(
		relPath
			&& isSafeRelativeUnder(ctx, GOALS_DIR, relPath)
			&& isDirectChildOf(relPath, GOALS_DIR)
			&& /^active_goal_.*\.md$/.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

function isSafeArchivedPath(ctx: ExtensionContext, relPath: string | undefined): relPath is string {
	return Boolean(
		relPath
			&& isSafeRelativeUnder(ctx, ARCHIVED_GOALS_DIR, relPath)
			&& isDirectChildOf(relPath, ARCHIVED_GOALS_DIR)
			&& /^goal_.*\.md$/.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

function sanitizeGoalPaths(ctx: ExtensionContext, current: GoalRecord): GoalRecord {
	const next = { ...current };
	if (!isSafeActivePath(ctx, next.activePath)) delete next.activePath;
	if (!isSafeArchivedPath(ctx, next.archivedPath)) delete next.archivedPath;
	return next;
}

function ensureNoExistingSymlinkAncestors(base: string, target: string): void {
	let current = base;
	const relative = path.relative(base, target);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`Goal path escapes workspace: ${target}`);
	}
	for (const segment of relative.split(path.sep)) {
		if (!segment) continue;
		current = path.join(current, segment);
		if (fs.existsSync(current) && fs.lstatSync(current).isSymbolicLink()) {
			throw new Error(`Refusing to write goal file through symlinked path: ${current}`);
		}
	}
}

function assertRealPathInside(parent: string, child: string, label: string): void {
	const parentReal = fs.realpathSync(parent);
	const childReal = fs.realpathSync(child);
	const relative = path.relative(parentReal, childReal);
	if (relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new Error(`${label} escapes workspace: ${child}`);
	}
}

function ensureNoSymlinkPath(base: string, root: string, dir: string): void {
	ensureNoExistingSymlinkAncestors(base, root);
	fs.mkdirSync(root, { recursive: true });
	ensureNoExistingSymlinkAncestors(base, dir);
	fs.mkdirSync(dir, { recursive: true });
	assertRealPathInside(base, root, "Goal directory");
	assertRealPathInside(root, dir, "Goal subdirectory");
}

function atomicWriteGoalFile(ctx: ExtensionContext, rootRel: string, relPath: string, content: string): void {
	const absolutePath = safeResolveUnder(ctx, rootRel, relPath);
	const base = path.resolve(ctx.cwd);
	const root = path.resolve(ctx.cwd, rootRel);
	const dir = path.dirname(absolutePath);
	ensureNoSymlinkPath(base, root, dir);
	if (fs.existsSync(absolutePath) && fs.lstatSync(absolutePath).isSymbolicLink()) {
		throw new Error(`Refusing to write symlinked goal file: ${relPath}`);
	}
	const tmp = path.join(dir, `.${path.basename(absolutePath)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
	fs.writeFileSync(tmp, content, { encoding: "utf8", flag: "wx" });
	fs.renameSync(tmp, absolutePath);
}

function safeUnlinkGoalFile(ctx: ExtensionContext, rootRel: string, relPath: string): void {
	const absolutePath = safeResolveUnder(ctx, rootRel, relPath);
	if (!fs.existsSync(absolutePath)) return;
	if (fs.lstatSync(absolutePath).isSymbolicLink()) {
		throw new Error(`Refusing to unlink symlinked goal file: ${relPath}`);
	}
	fs.unlinkSync(absolutePath);
}

function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") {
				escaped = true;
				continue;
			}
			if (char === "\"") inString = false;
			continue;
		}
		if (char === "\"") {
			inString = true;
			continue;
		}
		if (char === "{") {
			depth++;
			continue;
		}
		if (char === "}") {
			depth--;
			if (depth === 0) return i;
		}
	}
	return -1;
}

function extractObjectiveFromBody(body: string): string | undefined {
	const lines = body.replace(/^\s+/, "").split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "# Goal Prompt");
	if (start < 0) {
		const fallback = body.trim();
		return fallback || undefined;
	}
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "## Progress") {
			end = i;
			break;
		}
	}
	const text = lines.slice(start + 1, end).join("\n").trim();
	return text || undefined;
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return value === "active" || value === "paused" || value === "budget_limited" || value === "complete";
}

function isStopReason(value: unknown): value is StopReason {
	return value === "token_budget" || value === "max_turns" || value === "user" || value === "agent";
}

function optionalPositiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function parseGoalFile(filePath: string): GoalRecord | null {
	let content: string;
	try {
		if (fs.lstatSync(filePath).isSymbolicLink()) return null;
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	const end = findJsonObjectEnd(content);
	if (end < 0) return null;
	let raw: Partial<GoalRecord> & { version?: number };
	try {
		raw = JSON.parse(content.slice(0, end + 1)) as Partial<GoalRecord> & { version?: number };
	} catch {
		return null;
	}
	const bodyObjective = extractObjectiveFromBody(content.slice(end + 1));
	const objective = bodyObjective ?? raw.objective;
	if (!objective?.trim()) return null;
	const timestamp = nowIso();
	const status = isGoalStatus(raw.status) ? raw.status : "active";
	const goal: GoalRecord = {
		id: typeof raw.id === "string" && raw.id ? safeIdPart(raw.id) : newGoalId(),
		objective: objective.trim(),
		status,
		tokenBudget: optionalPositiveNumber(raw.tokenBudget),
		tokensUsed: typeof raw.tokensUsed === "number" && Number.isFinite(raw.tokensUsed) ? Math.max(0, Math.floor(raw.tokensUsed)) : 0,
		timeUsedSeconds: typeof raw.timeUsedSeconds === "number" && Number.isFinite(raw.timeUsedSeconds) ? Math.max(0, Math.floor(raw.timeUsedSeconds)) : 0,
		turns: typeof raw.turns === "number" && Number.isFinite(raw.turns) ? Math.max(0, Math.floor(raw.turns)) : 0,
		maxTurns: optionalPositiveNumber(raw.maxTurns),
		autoContinue: typeof raw.autoContinue === "boolean" ? raw.autoContinue : true,
		createdAt: typeof raw.createdAt === "string" ? raw.createdAt : timestamp,
		updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : timestamp,
		activeStartedAt: status === "active" && typeof raw.activeStartedAt === "string" ? raw.activeStartedAt : undefined,
		stopReason: isStopReason(raw.stopReason) ? raw.stopReason : undefined,
	};
	if (status !== "active") delete goal.activeStartedAt;
	return goal;
}

function serializeGoalFile(goal: GoalRecord): string {
	const g = snapshotGoal(goal);
	const meta = JSON.stringify({ version: 1, ...g }, null, 2);
	const progress = [
		`- Status: ${statusLabel(g.status)}`,
		`- Tokens: ${formatTokens(g.tokensUsed)}${g.tokenBudget ? ` / ${formatTokens(g.tokenBudget)}` : ""}`,
		`- Turns: ${g.turns}${g.maxTurns ? ` / ${g.maxTurns}` : ""}`,
		`- Elapsed: ${formatDuration(g.timeUsedSeconds)}`,
		`- Auto-continue: ${g.autoContinue ? "on" : "off"}`,
	];
	return `${meta}\n\n# Goal Prompt\n\n${g.objective.trim()}\n\n## Progress\n\n${progress.join("\n")}\n`;
}

function makeActiveGoalPath(goal: GoalRecord): string {
	return `${GOALS_DIR}/active_goal_${timestampForFile(goal.createdAt)}_${safeIdPart(goal.id)}.md`;
}

function makeArchivedGoalPath(goal: GoalRecord): string {
	return `${ARCHIVED_GOALS_DIR}/goal_${timestampForFile(goal.updatedAt)}_${safeIdPart(goal.id)}.md`;
}

function activePathForGoal(ctx: ExtensionContext, goal: GoalRecord): string {
	return isSafeActivePath(ctx, goal.activePath) ? goal.activePath : makeActiveGoalPath(goal);
}

function archivedPathForGoal(ctx: ExtensionContext, goal: GoalRecord): string {
	return isSafeArchivedPath(ctx, goal.archivedPath) ? goal.archivedPath : makeArchivedGoalPath(goal);
}

function writeActiveGoalFile(ctx: ExtensionContext, current: GoalRecord): GoalRecord {
	if (current.status === "complete") return archiveGoalFile(ctx, current);
	const activePath = activePathForGoal(ctx, current);
	const next = sanitizeGoalPaths(ctx, { ...current, activePath });
	atomicWriteGoalFile(ctx, GOALS_DIR, activePath, serializeGoalFile(next));
	return next;
}

function archiveGoalFile(ctx: ExtensionContext, current: GoalRecord): GoalRecord {
	const archivedPath = archivedPathForGoal(ctx, current);
	const next = sanitizeGoalPaths(ctx, { ...current, archivedPath });
	delete next.activePath;
	delete next.activeStartedAt;
	atomicWriteGoalFile(ctx, ARCHIVED_GOALS_DIR, archivedPath, serializeGoalFile(next));
	if (isSafeActivePath(ctx, current.activePath)) {
		try {
			safeUnlinkGoalFile(ctx, GOALS_DIR, current.activePath);
		} catch {
			// Keep the archive even if an unsafe or raced active file cannot be removed.
		}
	}
	return next;
}

function mergeGoalPromptFromDisk(ctx: ExtensionContext, current: GoalRecord): GoalRecord {
	if (!isSafeActivePath(ctx, current.activePath)) return current;
	try {
		const base = path.resolve(ctx.cwd);
		const root = path.resolve(ctx.cwd, GOALS_DIR);
		if (fs.existsSync(root)) assertRealPathInside(base, root, "Goal directory");
		const parsed = parseGoalFile(safeResolveUnder(ctx, GOALS_DIR, current.activePath));
		if (!parsed) return current;
		return {
			...current,
			objective: parsed.objective,
		};
	} catch {
		return current;
	}
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
	return typeof message === "object" && message !== null && (message as { role?: string }).role === "assistant";
}

function assistantTokenUsage(message: AssistantMessage): number {
	const usage = message.usage;
	if (!usage) return 0;
	if (Number.isFinite(usage.totalTokens)) return Math.max(0, Math.floor(usage.totalTokens));
	return Math.max(0, Math.floor((usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)));
}

function lastAssistantWasAborted(messages: unknown[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (isAssistantMessage(message)) return message.stopReason === "aborted";
	}
	return false;
}

function goalDetails(goal: GoalRecord | null): GoalStateEntry {
	return { version: 1, goal: goal ? snapshotGoal(goal) : null };
}

function renderGoalResult(result: { details?: unknown; content: Array<{ type: string; text?: string }> }, theme: Theme): Text {
	const details = result.details as GoalStateEntry | undefined;
	if (!details || typeof details !== "object" || !("goal" in details)) {
		const first = result.content[0];
		return new Text(first?.type === "text" ? (first.text ?? "") : "", 0, 0);
	}
	return new Text(theme.fg("accent", "Goal ") + theme.fg("muted", oneLineSummary(details.goal)), 0, 0);
}

function extractGoalIdFromInjectedMessage(text: string): string | null {
	const match = text.match(/^\[(?:GOAL CONTINUATION|GOAL TWEAK REQUEST) goalId=([^\]\s]+)\]/);
	return match?.[1] ?? null;
}

export default function goalExtension(pi: ExtensionAPI): void {
	let goal: GoalRecord | null = null;
	let continuationQueuedFor: string | null = null;
	let continuationTimer: ReturnType<typeof setTimeout> | null = null;
	let runningGoalId: string | null = null;

	function clearContinuationSchedule(): void {
		if (continuationTimer) {
			clearTimeout(continuationTimer);
			continuationTimer = null;
		}
		continuationQueuedFor = null;
	}

	function syncGoalPromptFromDisk(ctx: ExtensionContext): void {
		if (goal && goal.status !== "complete") goal = mergeGoalPromptFromDisk(ctx, goal);
	}

	function persist(ctx?: ExtensionContext, options?: { suspendActiveClock?: boolean }): void {
		if (goal) {
			if (ctx) syncGoalPromptFromDisk(ctx);
			goal = options?.suspendActiveClock ? suspendActiveClock(goal) : materializeGoal(goal);
			if (ctx) goal = goal.status === "complete" ? archiveGoalFile(ctx, goal) : writeActiveGoalFile(ctx, goal);
		}
		pi.appendEntry(STATE_ENTRY, { version: 1, goal: goal ? snapshotGoal(goal) : null } satisfies GoalStateEntry);
	}

	function updateUI(ctx: ExtensionContext): void {
		if (!ctx.hasUI) return;
		if (!goal) {
			ctx.ui.setStatus("goal", undefined);
			ctx.ui.setWidget("goal", undefined);
			return;
		}

		const g = snapshotGoal(goal);
		const usage = g.tokenBudget
			? `${formatTokens(g.tokensUsed)}/${formatTokens(g.tokenBudget)}`
			: `${formatTokens(g.tokensUsed)} tok`;
		ctx.ui.setStatus("goal", `goal: ${statusLabel(g.status)} ${usage}`);

		if (g.status === "complete") {
			ctx.ui.setWidget("goal", [
				ctx.ui.theme.fg("success", "Goal complete"),
				ctx.ui.theme.fg("muted", truncateText(g.objective)),
				...(g.archivedPath ? [ctx.ui.theme.fg("dim", g.archivedPath)] : []),
			]);
			return;
		}

		const lines = [
			ctx.ui.theme.fg("accent", `Goal: ${truncateText(g.objective)}`),
			ctx.ui.theme.fg("muted", `Status: ${statusLabel(g.status)} | ${formatDuration(g.timeUsedSeconds)} | ${usage}`),
		];
		if (g.maxTurns) lines.push(ctx.ui.theme.fg("dim", `Turns: ${g.turns}/${g.maxTurns}`));
		if (g.activePath) lines.push(ctx.ui.theme.fg("dim", g.activePath));
		if (g.status === "active") lines.push(ctx.ui.theme.fg("dim", "Use /goal tweak, /goal pause, or update_goal when complete."));
		ctx.ui.setWidget("goal", lines);
	}

	function loadState(ctx: ExtensionContext): void {
		goal = null;
		const entries = ctx.sessionManager.getBranch();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i] as { type?: string; customType?: string; data?: GoalStateEntry };
			if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data?.version === 1) {
				goal = entry.data.goal ? sanitizeGoalPaths(ctx, cloneGoal(entry.data.goal)) : null;
				break;
			}
		}
		if (goal && goal.status !== "complete") {
			goal = resumeActiveClock(mergeGoalPromptFromDisk(ctx, goal));
		}
		clearContinuationSchedule();
		runningGoalId = null;
		updateUI(ctx);
	}

	function setGoal(next: GoalRecord | null, ctx: ExtensionContext, shouldPersist = true): void {
		goal = next;
		if (
			!goal
			|| goal.status !== "active"
			|| !goal.autoContinue
			|| (continuationQueuedFor !== null && continuationQueuedFor !== goal.id)
		) {
			clearContinuationSchedule();
		}
		if (shouldPersist) persist(ctx);
		updateUI(ctx);
	}

	function archiveCurrentGoal(ctx: ExtensionContext, reason: StopReason | undefined): GoalRecord | null {
		if (!goal) return null;
		let archived = mergeGoalPromptFromDisk(ctx, goal);
		archived = materializeGoal(archived);
		if (archived.status === "active") archived.status = "paused";
		archived.stopReason = reason;
		return archiveGoalFile(ctx, archived);
	}

	function stopActiveGoal(status: Exclude<GoalStatus, "active">, reason: StopReason | undefined, ctx: ExtensionContext): void {
		if (!goal) return;
		let next = mergeGoalPromptFromDisk(ctx, goal);
		next = materializeGoal(next);
		next.status = status;
		next.stopReason = reason;
		delete next.activeStartedAt;
		setGoal(next, ctx);
	}

	function enforceBudgets(ctx: ExtensionContext): void {
		if (!goal || goal.status !== "active") return;
		if (goal.tokenBudget && goal.tokensUsed >= goal.tokenBudget) {
			stopActiveGoal("budget_limited", "token_budget", ctx);
			ctx.ui.notify("Goal paused: token budget reached after the current turn.", "warning");
			return;
		}
		if (goal.maxTurns && goal.turns >= goal.maxTurns) {
			stopActiveGoal("budget_limited", "max_turns", ctx);
			ctx.ui.notify("Goal paused: max turns reached.", "warning");
		}
	}

	function sendQueuedContinuation(ctx: ExtensionContext, goalId: string): void {
		continuationTimer = null;
		if (!goal || goal.id !== goalId || goal.status !== "active" || !goal.autoContinue) {
			if (continuationQueuedFor === goalId) continuationQueuedFor = null;
			return;
		}
		if (ctx.hasPendingMessages()) {
			if (continuationQueuedFor === goalId) continuationQueuedFor = null;
			return;
		}
		if (!ctx.isIdle()) {
			continuationTimer = setTimeout(() => sendQueuedContinuation(ctx, goalId), CONTINUATION_IDLE_RETRY_MS);
			return;
		}
		const prompt = continuationPrompt(goal);
		pi.sendUserMessage(prompt);
	}

	function queueContinuation(ctx: ExtensionContext, force = false): void {
		if (!goal || goal.status !== "active" || !goal.autoContinue) return;
		if (!force && continuationQueuedFor === goal.id) return;
		if (ctx.hasPendingMessages()) return;
		const goalId = goal.id;
		continuationQueuedFor = goalId;
		if (continuationTimer) clearTimeout(continuationTimer);
		if (ctx.isIdle()) {
			sendQueuedContinuation(ctx, goalId);
		} else {
			continuationTimer = setTimeout(() => sendQueuedContinuation(ctx, goalId), CONTINUATION_IDLE_RETRY_MS);
		}
	}

	function replaceGoal(parsed: ParsedGoalArgs, ctx: ExtensionContext, startNow = true): void {
		if (goal && goal.status !== "complete") archiveCurrentGoal(ctx, "user");
		setGoal(createGoal(parsed), ctx);
		ctx.ui.notify(`Goal active: ${truncateText(parsed.objective)}`, "info");
		if (startNow && goal?.autoContinue) queueContinuation(ctx, true);
	}

	function requestGoalTweak(instructions: string, ctx: ExtensionContext): void {
		if (!goal) {
			ctx.ui.notify("No goal is set.", "warning");
			return;
		}
		if (goal.status === "complete") {
			ctx.ui.notify("Goal is complete. Use /goal replace <objective> to start a new one.", "warning");
			return;
		}
		const trimmed = instructions.trim();
		if (!trimmed) {
			ctx.ui.notify("Usage: /goal tweak <instructions for the agent>", "warning");
			return;
		}

		goal = mergeGoalPromptFromDisk(ctx, materializeGoal(goal));
		persist(ctx);
		const activePath = goal.activePath ?? activePathForGoal(ctx, goal);
		const message = `[GOAL TWEAK REQUEST goalId=${goal.id}]\nThe user wants to tweak the active goal. Update the active goal file instead of treating this as a normal implementation task.\n\nActive goal file: ${activePath}\n\nCurrent goal prompt:\n${goal.objective}\n\nRequested tweak:\n${trimmed}\n\nInstructions:\n1. Read the active goal file.\n2. Edit only the # Goal Prompt section so it reflects the requested tweak while preserving useful existing constraints.\n3. Do not mark the goal complete merely because the prompt changed.\n4. After updating the file, continue working under the revised goal prompt. If blocked, explain the blocker.`;
		if (ctx.isIdle()) {
			pi.sendUserMessage(message);
		} else {
			pi.sendUserMessage(message, { deliverAs: "steer" });
		}
		ctx.ui.notify("Queued goal tweak for the agent.", "info");
	}

	async function setGoalFromCommand(args: string, ctx: ExtensionContext, replaceExisting: boolean): Promise<void> {
		const parsed = parseGoalArgs(args);
		if ("error" in parsed) {
			ctx.ui.notify(parsed.error, "error");
			return;
		}

		if (goal && goal.status !== "complete" && !replaceExisting) {
			if (!ctx.hasUI) {
				ctx.ui.notify("A goal already exists. Use /goal replace <objective> to replace it.", "warning");
				return;
			}
			const ok = await ctx.ui.confirm("Replace current goal?", `Current: ${goal.objective}\n\nNew: ${parsed.objective}`);
			if (!ok) {
				ctx.ui.notify("Goal unchanged.", "info");
				return;
			}
		}

		replaceGoal(parsed, ctx);
	}

	pi.registerCommand("goal", {
		description: "Set, view, ask the agent to tweak, pause, resume, or clear a long-running goal",
		getArgumentCompletions(prefix) {
			const items = ["status", "tweak", "pause", "resume", "clear", "replace", "--tokens ", "--max-turns ", "--no-auto"];
			return items
				.filter((item) => item.startsWith(prefix))
				.map((item) => ({ value: item, label: item, description: "goal command" }));
		},
		handler: async (rawArgs, ctx) => {
			const args = rawArgs.trim();
			if (!args || args === "status") {
				syncGoalPromptFromDisk(ctx);
				ctx.ui.notify(detailedSummary(goal), "info");
				updateUI(ctx);
				return;
			}

			const [command, ...rest] = args.split(/\s+/);
			const restText = rest.join(" ").trim();
			switch (command.toLowerCase()) {
				case "clear": {
					const archived = archiveCurrentGoal(ctx, "user");
					setGoal(null, ctx);
					ctx.ui.notify(archived ? "Goal cleared and archived." : "No goal is set.", archived ? "info" : "warning");
					return;
				}
				case "tweak":
					requestGoalTweak(restText, ctx);
					return;
				case "pause":
					if (!goal) {
						ctx.ui.notify("No goal is set.", "warning");
						return;
					}
					if (goal.status === "complete") {
						ctx.ui.notify("Goal is already complete.", "warning");
						return;
					}
					stopActiveGoal("paused", "user", ctx);
					ctx.ui.notify("Goal paused.", "info");
					return;
				case "resume":
					if (!goal) {
						ctx.ui.notify("No goal is set.", "warning");
						return;
					}
					if (goal.status === "complete") {
						ctx.ui.notify("Goal is complete. Use /goal replace <objective> to start a new one.", "warning");
						return;
					}
					goal = resumeActiveClock(mergeGoalPromptFromDisk(ctx, goal));
					setGoal({ ...materializeGoal(goal), status: "active", stopReason: undefined, activeStartedAt: nowIso() }, ctx);
					ctx.ui.notify("Goal resumed.", "info");
					queueContinuation(ctx, true);
					return;
				case "replace":
					await setGoalFromCommand(restText, ctx, true);
					return;
				default:
					await setGoalFromCommand(args, ctx, false);
			}
		},
	});

	pi.registerTool(defineTool({
		name: "get_goal",
		label: "Get Goal",
		description: "Get the current pi goal for this session, including objective, status, token budget, usage, elapsed time, turn count, and local file paths.",
		promptSnippet: "Read the active pi goal state for the current session.",
		promptGuidelines: [
			"Use get_goal when you need the current pi goal state before deciding whether to continue or mark it complete.",
		],
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			syncGoalPromptFromDisk(ctx);
			return {
				content: [{ type: "text", text: detailedSummary(goal) }],
				details: goalDetails(goal),
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
		description: "Create a new active pi goal only when the user explicitly asks to set a long-running goal. Fails if an unfinished goal already exists.",
		promptSnippet: "Create a persistent pi goal when explicitly requested by the user.",
		promptGuidelines: [
			"Use create_goal only when the user explicitly asks to set, start, or track a long-running goal; do not infer goals from ordinary tasks.",
		],
		parameters: Type.Object({
			objective: Type.String({ description: "Concrete objective to pursue." }),
			tokenBudget: Type.Optional(Type.Number({ description: "Optional positive token budget." })),
			maxTurns: Type.Optional(Type.Number({ description: "Optional maximum autonomous turns. 0 or omitted means no turn limit." })),
			autoContinue: Type.Optional(Type.Boolean({ description: "Whether pi should keep sending continuation prompts until complete. Defaults to true." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (goal && goal.status !== "complete") {
				return {
					content: [{ type: "text", text: "An unfinished goal already exists. Ask the user before replacing it." }],
					details: goalDetails(goal),
				};
			}
			const parsed: ParsedGoalArgs = {
				objective: params.objective.trim(),
				tokenBudget: params.tokenBudget && params.tokenBudget > 0 ? Math.floor(params.tokenBudget) : undefined,
				maxTurns: params.maxTurns && params.maxTurns > 0 ? Math.floor(params.maxTurns) : undefined,
				autoContinue: params.autoContinue ?? true,
			};
			if (!parsed.objective) throw new Error("Goal objective must not be empty.");
			replaceGoal(parsed, ctx, false);
			return {
				content: [{ type: "text", text: `Goal created. ${oneLineSummary(goal)}` }],
				details: goalDetails(goal),
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", "create_goal ") + theme.fg("muted", args.objective ?? ""), 0, 0);
		},
		renderResult(result, _options, theme) {
			return renderGoalResult(result, theme);
		},
	}));

	pi.registerTool(defineTool({
		name: "update_goal",
		label: "Update Goal",
		description: "Update the current pi goal. The model may only mark an existing active goal complete when the objective is actually achieved.",
		promptSnippet: "Mark the active pi goal complete when the objective is achieved.",
		promptGuidelines: [
			"Use update_goal with status=complete only when the pi goal objective has actually been achieved and no required work remains.",
			"Do not use update_goal merely because a budget is almost exhausted or because you are stopping work; explain blockers instead.",
		],
		parameters: Type.Object({
			status: StringEnum([COMPLETE_STATUS] as const, { description: "Set to complete only when the objective is achieved." }),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (params.status !== COMPLETE_STATUS) throw new Error("update_goal only supports status=complete.");
			if (!goal) {
				return {
					content: [{ type: "text", text: "No goal is set." }],
					details: goalDetails(goal),
				};
			}
			if (runningGoalId && goal.id !== runningGoalId) {
				return {
					content: [{ type: "text", text: "The active goal changed during this run; not marking it complete." }],
					details: goalDetails(goal),
				};
			}
			if (goal.status !== "active") {
				return {
					content: [{ type: "text", text: `Goal is ${statusLabel(goal.status)}; ask the user to resume it before marking complete.` }],
					details: goalDetails(goal),
				};
			}
			goal = mergeGoalPromptFromDisk(ctx, goal);
			stopActiveGoal("complete", "agent", ctx);
			return {
				content: [{ type: "text", text: `Goal complete. ${oneLineSummary(goal)}` }],
				details: goalDetails(goal),
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

	pi.on("input", async (event) => {
		if (event.source !== "extension") return;
		const staleGoalId = extractGoalIdFromInjectedMessage(event.text);
		if (staleGoalId && goal?.id !== staleGoalId) return { action: "handled" as const };
	});

	pi.on("session_start", async (_event, ctx) => {
		loadState(ctx);
		queueContinuation(ctx, true);
	});
	pi.on("session_compact", async (_event, ctx) => {
		if (goal?.status === "active" && goal.autoContinue) queueContinuation(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => loadState(ctx));

	pi.on("before_agent_start", async (event, ctx) => {
		if (!goal) {
			runningGoalId = null;
			return;
		}
		if (goal.status !== "complete") goal = mergeGoalPromptFromDisk(ctx, goal);
		const g = snapshotGoal(goal);
		runningGoalId = g.status === "active" ? g.id : null;
		if (g.status === "complete") return;
		if (g.status === "paused") {
			return {
				systemPrompt: `${event.systemPrompt}\n\n[PI GOAL PAUSED goalId=${g.id}]\nObjective: ${g.objective}\nThe goal is paused. Do not autonomously continue it unless the user resumes it with /goal resume.`,
			};
		}
		if (g.status === "budget_limited") {
			return {
				systemPrompt: `${event.systemPrompt}\n\n[PI GOAL BUDGET LIMITED goalId=${g.id}]\nObjective: ${g.objective}\nThe goal hit a configured budget. Do not continue it unless the user resumes or replaces it.`,
			};
		}
		return { systemPrompt: `${event.systemPrompt}\n\n${goalPrompt(g)}` };
	});

	pi.on("message_end", async (event, ctx) => {
		if (!goal || goal.status !== "active") return;
		if (runningGoalId && goal.id !== runningGoalId) return;
		if (!isAssistantMessage(event.message)) return;
		const tokens = assistantTokenUsage(event.message);
		if (tokens <= 0) return;
		let next = mergeGoalPromptFromDisk(ctx, goal);
		next = materializeGoal(next);
		next.tokensUsed += tokens;
		goal = next;
		persist(ctx);
		updateUI(ctx);
	});

	pi.on("agent_end", async (event, ctx) => {
		const endedGoalId = runningGoalId;
		runningGoalId = null;
		continuationQueuedFor = null;
		if (!goal || goal.status !== "active") return;
		if (endedGoalId && goal.id !== endedGoalId) return;
		goal = mergeGoalPromptFromDisk(ctx, goal);

		if (lastAssistantWasAborted(event.messages as unknown[])) {
			stopActiveGoal("paused", "user", ctx);
			ctx.ui.notify("Goal paused after abort.", "warning");
			return;
		}

		let next = materializeGoal(goal);
		next.turns += 1;
		goal = next;
		persist(ctx);
		enforceBudgets(ctx);
		updateUI(ctx);

		if (goal?.status === "active") queueContinuation(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearContinuationSchedule();
		if (goal) persist(ctx, { suspendActiveClock: true });
	});
}
