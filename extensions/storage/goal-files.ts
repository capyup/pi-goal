import * as fs from "node:fs";
import * as path from "node:path";

import {
	formatDuration,
	formatTokenBudget,
	formatTokenValue,
	statusLabel,
} from "../goal-core.ts";
import {
	cloneGoal,
	normalizeGoalRecord,
	normalizeRelPath,
	nowIso,
	safeIdPart,
	type GoalRecord,
} from "../goal-record.ts";

export const GOALS_DIR = ".pi/goals";
export const ARCHIVED_GOALS_DIR = ".pi/goals/archived";

export interface GoalFileContext {
	cwd: string;
}

export function timestampForFile(iso = nowIso()): string {
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

export function isSafeRelativeUnder(ctx: GoalFileContext, rootRel: string, relPath: string | undefined): relPath is string {
	if (!relPath || path.isAbsolute(relPath) || relPath.includes("\0")) return false;
	const normalized = normalizeRelPath(relPath);
	const parent = normalizeRelPath(path.posix.dirname(normalized));
	if (parent !== normalizeRelPath(rootRel)) return false;
	const root = path.resolve(ctx.cwd, rootRel);
	const absolutePath = path.resolve(ctx.cwd, normalized);
	const relative = path.relative(root, absolutePath);
	return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isSafeActivePath(ctx: GoalFileContext, relPath: string | undefined): relPath is string {
	return Boolean(
		isSafeRelativeUnder(ctx, GOALS_DIR, relPath)
			&& /^active_goal_.*\.md$/.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

export function isSafeArchivedPath(ctx: GoalFileContext, relPath: string | undefined): relPath is string {
	return Boolean(
		isSafeRelativeUnder(ctx, ARCHIVED_GOALS_DIR, relPath)
			&& /^goal_.*\.md$/.test(path.posix.basename(normalizeRelPath(relPath))),
	);
}

export function sanitizeGoalPaths(ctx: GoalFileContext, goal: GoalRecord): GoalRecord {
	const next = cloneGoal(goal);
	if (!isSafeActivePath(ctx, next.activePath)) delete next.activePath;
	if (!isSafeArchivedPath(ctx, next.archivedPath)) delete next.archivedPath;
	return next;
}

export function ensureDirectory(ctx: GoalFileContext, relPath: string): void {
	const absolutePath = path.resolve(ctx.cwd, relPath);
	fs.mkdirSync(absolutePath, { recursive: true });
	if (fs.lstatSync(absolutePath).isSymbolicLink()) throw new Error(`Goal directory is a symlink: ${relPath}`);
}

export function resolveGoalPath(ctx: GoalFileContext, rootRel: string, relPath: string): string {
	const root = path.resolve(ctx.cwd, rootRel);
	const absolutePath = path.resolve(ctx.cwd, normalizeRelPath(relPath));
	const relative = path.relative(root, absolutePath);
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Goal path escapes ${rootRel}: ${relPath}`);
	return absolutePath;
}

export function atomicWriteGoalFile(ctx: GoalFileContext, rootRel: string, relPath: string, content: string): void {
	ensureDirectory(ctx, rootRel);
	const filePath = resolveGoalPath(ctx, rootRel, relPath);
	if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
		throw new Error(`Refusing to write symlinked goal file: ${relPath}`);
	}
	const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(tempPath, content, "utf8");
	fs.renameSync(tempPath, filePath);
}

export function safeUnlinkGoalFile(ctx: GoalFileContext, rootRel: string, relPath: string): void {
	const filePath = resolveGoalPath(ctx, rootRel, relPath);
	if (fs.existsSync(filePath) && !fs.lstatSync(filePath).isSymbolicLink()) fs.unlinkSync(filePath);
}

export function makeActiveGoalPath(goal: GoalRecord): string {
	return `${GOALS_DIR}/active_goal_${timestampForFile(goal.createdAt)}_${safeIdPart(goal.id)}.md`;
}

export function makeArchivedGoalPath(goal: GoalRecord): string {
	return `${ARCHIVED_GOALS_DIR}/goal_${timestampForFile(goal.updatedAt)}_${safeIdPart(goal.id)}.md`;
}

export function activePathForGoal(ctx: GoalFileContext, goal: GoalRecord): string {
	return isSafeActivePath(ctx, goal.activePath) ? goal.activePath : makeActiveGoalPath(goal);
}

export function archivedPathForGoal(ctx: GoalFileContext, goal: GoalRecord): string {
	return isSafeArchivedPath(ctx, goal.archivedPath) ? goal.archivedPath : makeArchivedGoalPath(goal);
}

export function serializeGoalFile(goal: GoalRecord): string {
	const meta = JSON.stringify({ version: 3, ...goal }, null, 2);
	const pauseLines: string[] = [];
	if (goal.pauseReason) pauseLines.push(`- Agent pause reason: ${goal.pauseReason}`);
	if (goal.pauseSuggestedAction) pauseLines.push(`- Agent suggests: ${goal.pauseSuggestedAction}`);
	const pauseBlock = pauseLines.length > 0 ? `\n${pauseLines.join("\n")}` : "";
	return `${meta}

# Goal Prompt

${goal.objective.trim()}

## Progress

- Status: ${statusLabel(goal)}
- Auto-continue: ${goal.autoContinue ? "on" : "off"}
- Sisyphus mode: ${goal.sisyphus ? "yes (prompt/criteria style)" : "no"}
- Time spent: ${formatDuration(goal.usage.activeSeconds)}
- Tokens used: ${formatTokenValue(goal.usage.tokensUsed)}
- Token budget: ${formatTokenBudget(goal)}${pauseBlock}
`;
}

export function findJsonObjectEnd(content: string): number {
	let depth = 0;
	let inString = false;
	let escaped = false;

	for (let i = 0; i < content.length; i++) {
		const char = content[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (char === "\\") {
				escaped = true;
			} else if (char === "\"") {
				inString = false;
			}
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

export function extractObjectiveFromBody(body: string): string | undefined {
	const lines = body.replace(/^\s+/, "").split(/\r?\n/);
	const start = lines.findIndex((line) => line.trim() === "# Goal Prompt");
	if (start < 0) return body.trim() || undefined;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i]?.trim() === "## Progress") {
			end = i;
			break;
		}
	}
	return lines.slice(start + 1, end).join("\n").trim() || undefined;
}

export function parseGoalFile(filePath: string): GoalRecord | null {
	let content: string;
	try {
		if (fs.lstatSync(filePath).isSymbolicLink()) return null;
		content = fs.readFileSync(filePath, "utf8");
	} catch {
		return null;
	}
	const end = findJsonObjectEnd(content);
	if (end < 0) return null;
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(content.slice(0, end + 1)) as Record<string, unknown>;
	} catch {
		return null;
	}
	const objective = extractObjectiveFromBody(content.slice(end + 1)) ?? raw.objective;
	return normalizeGoalRecord({ ...raw, objective });
}

export function writeActiveGoalFile(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	if (current.status === "complete") return archiveGoalFile(ctx, current);
	const activePath = activePathForGoal(ctx, current);
	const next = sanitizeGoalPaths(ctx, { ...current, activePath, updatedAt: nowIso() });
	atomicWriteGoalFile(ctx, GOALS_DIR, activePath, serializeGoalFile(next));
	return next;
}

export function archiveGoalFile(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	const archivedPath = archivedPathForGoal(ctx, current);
	const next = sanitizeGoalPaths(ctx, { ...current, archivedPath, updatedAt: nowIso() });
	delete next.activePath;
	atomicWriteGoalFile(ctx, ARCHIVED_GOALS_DIR, archivedPath, serializeGoalFile(next));
	if (isSafeActivePath(ctx, current.activePath)) {
		try {
			safeUnlinkGoalFile(ctx, GOALS_DIR, current.activePath);
		} catch {}
	}
	return next;
}

export function mergeGoalPromptFromDisk(ctx: GoalFileContext, current: GoalRecord): GoalRecord {
	if (!isSafeActivePath(ctx, current.activePath)) return current;
	try {
		const parsed = parseGoalFile(resolveGoalPath(ctx, GOALS_DIR, current.activePath));
		if (!parsed) return current;
		return { ...current, objective: parsed.objective };
	} catch {
		return current;
	}
}

export function readActiveGoalFiles(ctx: GoalFileContext): GoalRecord[] {
	const root = path.resolve(ctx.cwd, GOALS_DIR);
	let entries: string[];
	try {
		if (fs.lstatSync(root).isSymbolicLink()) return [];
		entries = fs.readdirSync(root);
	} catch {
		return [];
	}
	return entries
		.filter((name) => /^active_goal_.*\.md$/.test(name))
		.sort((a, b) => a.localeCompare(b))
		.map((name) => {
			const relPath = `${GOALS_DIR}/${name}`;
			if (!isSafeActivePath(ctx, relPath)) return null;
			const parsed = parseGoalFile(resolveGoalPath(ctx, GOALS_DIR, relPath));
			if (!parsed || parsed.status === "complete") return null;
			return sanitizeGoalPaths(ctx, { ...parsed, activePath: relPath });
		})
		.filter((goal): goal is GoalRecord => goal !== null);
}

export function readActiveGoalPool(ctx: GoalFileContext): Map<string, GoalRecord> {
	const pool = new Map<string, GoalRecord>();
	for (const goal of readActiveGoalFiles(ctx)) {
		pool.set(goal.id, goal);
	}
	return pool;
}
