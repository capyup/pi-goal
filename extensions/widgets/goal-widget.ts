import type { Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	displayObjectiveTitle,
	formatDuration,
	formatRemainingTokens,
	formatTokenBudget,
	formatTokenValue,
	truncateText,
	type GoalDisplayRecordLike,
} from "../goal-core.ts";


type GoalWidgetColor = Extract<ThemeColor, "accent" | "warning" | "success" | "error" | "dim" | "muted" | "text">;

export interface GoalWidgetRecord extends GoalDisplayRecordLike {
	activePath?: string | null;
	archivedPath?: string | null;
	pauseReason?: string;
	pauseSuggestedAction?: string;
}

export interface GoalWidgetOptions {
	theme: Theme;
	tui: TUI;
	getGoal: () => GoalWidgetRecord | null;
	getOpenGoalCount?: () => number;
}

function fit(value: string, width: number): string {
	return visibleWidth(value) > width ? truncateToWidth(value, width, "…") : value;
}

function heading(theme: Theme, width: number, left: string, right = ""): string {
	if (!right) return fit(left, width);
	const rightPart = ` ${right}`;
	const fill = Math.max(1, width - visibleWidth(left) - visibleWidth(rightPart));
	return fit(`${left}${theme.fg("dim", " ".repeat(fill))}${rightPart}`, width);
}

function branchLine(theme: Theme, width: number, isLast: boolean, content: string): string {
	const prefix = isLast ? "└─" : "├─";
	return fit(`${theme.fg("dim", prefix)} ${content}`, width);
}

function displayIcon(goal: GoalWidgetRecord): { icon: string; color: GoalWidgetColor; label: string } {
	if (goal.status === "complete") return { icon: "✓", color: "success", label: "complete" };
	if (goal.status === "paused") {
		return goal.stopReason === "agent"
			? { icon: "⊘", color: "warning", label: "blocked" }
			: { icon: "◐", color: "muted", label: "paused" };
	}
	if (goal.status === "budgetLimited") return { icon: "◑", color: "warning", label: "budget" };
	if (goal.sisyphus) return { icon: "◆", color: "accent", label: goal.autoContinue ? "sisyphus running" : "sisyphus idle" };
	return goal.autoContinue ? { icon: "●", color: "accent", label: "goal running" } : { icon: "○", color: "muted", label: "goal idle" };
}

function headingMeta(goal: GoalWidgetRecord, otherOpenGoalCount = 0): string {
	const bits: string[] = [];
	if (goal.status === "active" && goal.autoContinue) bits.push("auto");
	if (goal.usage.activeSeconds > 0) bits.push(formatDuration(goal.usage.activeSeconds));
	if (goal.usage.tokensUsed > 0) bits.push(formatTokenValue(goal.usage.tokensUsed));
	if (otherOpenGoalCount > 0) bits.push(`+${otherOpenGoalCount} open`);
	return bits.join(" · ");
}

export function renderGoalWidgetLines(goal: GoalWidgetRecord | null, theme: Theme, width: number, options: { openGoalCount?: number } = {}): string[] {
	if (!goal) {
		const openGoalCount = options.openGoalCount ?? 0;
		if (openGoalCount <= 0) return [];
		const safeWidth = Math.max(1, width);
		return [
			heading(theme, safeWidth, `${theme.fg("warning", "◇")} ${theme.fg("warning", theme.bold("Goal"))} ${theme.fg("muted", "unfocused")}`, theme.fg("muted", `${openGoalCount} open`)),
			branchLine(theme, safeWidth, true, `${theme.fg("muted", "Run /goal-focus to choose this session's goal")}`),
		];
	}
	const safeWidth = Math.max(1, width);
	const { icon, color, label } = displayIcon(goal);
	const mode = goal.sisyphus ? "Sisyphus" : "Goal";
	const headingLeft = `${theme.fg(color, icon)} ${theme.fg(color, theme.bold(mode))} ${theme.fg("muted", label.replace(/^sisyphus |^goal /, ""))}`;
	const otherOpenGoalCount = Math.max(0, (options.openGoalCount ?? (goal ? 1 : 0)) - 1);
	const headingRight = theme.fg("muted", headingMeta(goal, otherOpenGoalCount));
	const lines: string[] = [heading(theme, safeWidth, headingLeft, headingRight)];
	const body: string[] = [];

	const titleWidth = Math.max(12, safeWidth - 8);
	const objective = truncateText(displayObjectiveTitle(goal.objective), titleWidth);
	body.push(`${theme.fg("accent", "⟡")} ${theme.fg("text", objective)}`);

	if (goal.tokenBudget !== null) {
		body.push(`${theme.fg("dim", "budget")} ${theme.fg("muted", `${formatTokenBudget(goal)} · remaining ${formatRemainingTokens(goal)}`)}`);
	}

	if (goal.status === "paused" && goal.stopReason === "agent" && goal.pauseReason) {
		body.push(`${theme.fg("warning", "blocker")} ${theme.fg("warning", truncateText(goal.pauseReason, Math.max(12, safeWidth - 14)))}`);
		if (goal.pauseSuggestedAction) {
			body.push(`${theme.fg("dim", "next")} ${theme.fg("muted", truncateText(goal.pauseSuggestedAction, Math.max(12, safeWidth - 10)))}`);
		}
	}

	const path = goal.status === "complete" ? goal.archivedPath : goal.activePath;
	if (path) {
		body.push(theme.fg("dim", path));
	}

	for (const [index, content] of body.entries()) {
		lines.push(branchLine(theme, safeWidth, index === body.length - 1, content));
	}

	return lines;
}

export class GoalWidgetComponent implements Component {
	private theme: Theme;
	private tui: TUI;
	private getGoal: () => GoalWidgetRecord | null;
	private getOpenGoalCount: () => number;

	constructor(options: GoalWidgetOptions) {
		this.theme = options.theme;
		this.tui = options.tui;
		this.getGoal = options.getGoal;
		this.getOpenGoalCount = options.getOpenGoalCount ?? (() => (this.getGoal() ? 1 : 0));
	}

	update(): void {
		this.tui.requestRender();
	}

	render(width: number): string[] {
		return renderGoalWidgetLines(this.getGoal(), this.theme, width, { openGoalCount: this.getOpenGoalCount() });
	}

	invalidate(): void {
		this.tui.requestRender();
	}
}
