import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Editor, type EditorTheme, Key, matchesKey, Text, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

import { truncateText } from "./goal-core.ts";
import { QUESTIONNAIRE_TOOL_NAME, QUESTION_TOOL_NAME } from "./goal-tool-names.ts";
import type { GoalDraftingFocus } from "./goal-draft.ts";

export interface GoalQuestionnaireQuestion {
	id: string;
	question: string;
	context?: string;
	options: string[];
	recommended?: number;
	allowCustom?: boolean;
}

export interface GoalQuestionnaireAnswer {
	id: string;
	question: string;
	answer: string;
	wasCustom: boolean;
}

export interface GoalQuestionnaireResult {
	questions: GoalQuestionnaireQuestion[];
	answers: GoalQuestionnaireAnswer[];
	cancelled: boolean;
}

export type ProposalDecision = "confirm" | "continue";

export function normalizeQuestionnaireQuestions(rawQuestions: GoalQuestionnaireQuestion[]): GoalQuestionnaireQuestion[] {
	const seenIds = new Set<string>();
	return rawQuestions.map((q, i) => {
		let id = q.id.trim() || `q${i + 1}`;
		if (seenIds.has(id)) id = `${id}-${i + 1}`;
		seenIds.add(id);
		const options = q.options.filter((option) => option.trim().length > 0);
		const recommended = q.recommended !== undefined && q.recommended >= 0 && q.recommended < options.length
			? q.recommended
			: undefined;
		return { ...q, id, options, recommended, allowCustom: q.allowCustom ?? true };
	});
}

export function formatQuestionnaireAnswers(result: GoalQuestionnaireResult): string {
	return result.answers.map((answer) => {
		const question = result.questions.find((q) => q.id === answer.id);
		const lines = [`**Q:** ${answer.question}`];
		if (question?.context) lines.push(`\n${question.context}`);
		if (question && question.options.length > 0) lines.push(`\nOptions: ${question.options.join(" / ")}`);
		lines.push(`\n**A:** ${answer.answer}`);
		return lines.join("");
	}).join("\n\n---\n\n");
}

export function shouldAutoConfirmProposal(args: { hasUI: boolean; autoConfirmEnv?: string }): boolean {
	return !args.hasUI || args.autoConfirmEnv === "1";
}

export function proposalDecisionFromQuestionnaireResult(args: { cancelled: boolean; answer?: string }): ProposalDecision {
	if (args.cancelled) return "continue";
	return (args.answer ?? "").startsWith("Confirm") ? "confirm" : "continue";
}

export function isHeadlessQuestionSufficientForDraft(args: { topic: string; questionText: string }): boolean {
	const topic = args.topic.toLowerCase();
	void args;
	const vagueTopic = topic.trim().length < 20 || /(整理笔记|organize notes|notes|笔记)$/.test(topic.trim());
	return !vagueTopic;
}

export function proposalDialogFailureMessage(error: unknown): string {
	const detail = error instanceof Error ? error.message : String(error);
	return `Goal draft confirmation failed: ${detail}. The goal was NOT created; drafting remains active.`;
}

/**
 * Shared question UI used by both the agent-callable goal_questionnaire tool and
 * the internal draft-confirm prompt. This keeps pi-goal self-contained and
 * avoids depending on external question/questionnaire packages.
 */
export async function runGoalQuestionnaire(ctx: ExtensionContext, rawQuestions: GoalQuestionnaireQuestion[]): Promise<GoalQuestionnaireResult> {
	if (!ctx.hasUI) {
		return { questions: [], answers: [], cancelled: true };
	}

	const questions = normalizeQuestionnaireQuestions(rawQuestions);
	const isMulti = questions.length > 1;
	const totalTabs = questions.length + 1;

	return await ctx.ui.custom<GoalQuestionnaireResult>((tui, theme, _kb, done) => {
		let currentTab = 0;
		let optionIndex = 0;
		let inputMode = false;
		let inputQuestionId: string | null = null;
		let cachedLines: string[] | undefined;
		const answers = new Map<string, GoalQuestionnaireAnswer>();
		const drafts = new Map<string, string>();

		const editorTheme: EditorTheme = {
			borderColor: (s) => theme.fg("accent", s),
			selectList: {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			},
		};
		const editor = new Editor(tui, editorTheme);

		function refresh() {
			cachedLines = undefined;
			tui.requestRender();
		}

		function submit(cancelled: boolean) {
			const ordered = questions.map((q) => answers.get(q.id)).filter((a): a is GoalQuestionnaireAnswer => !!a);
			done({ questions, answers: ordered, cancelled });
		}

		function currentQuestion(): GoalQuestionnaireQuestion | undefined {
			return questions[currentTab];
		}

		function displayOptions(): Array<{ label: string; isCustom?: boolean }> {
			const q = currentQuestion();
			if (!q) return [];
			const opts: Array<{ label: string; isCustom?: boolean }> = q.options.map((label) => ({ label }));
			if (q.allowCustom !== false) opts.push({ label: "Write your own answer...", isCustom: true });
			return opts;
		}

		function allAnswered(): boolean {
			return questions.every((q) => answers.has(q.id));
		}

		function enterQuestion(q: GoalQuestionnaireQuestion) {
			const existing = answers.get(q.id);
			const draft = drafts.get(q.id);
			if (q.options.length === 0) {
				inputMode = true;
				inputQuestionId = q.id;
				editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
			} else if (existing?.wasCustom) {
				optionIndex = q.options.length;
			} else if (existing && !existing.wasCustom) {
				const idx = q.options.indexOf(existing.answer);
				optionIndex = idx >= 0 ? idx : 0;
			} else {
				optionIndex = q.recommended ?? 0;
			}
		}

		function advanceAfterAnswer() {
			if (!isMulti) {
				submit(false);
				return;
			}
			if (currentTab < questions.length - 1) currentTab++;
			else currentTab = questions.length;
			const nextQ = currentQuestion();
			if (nextQ) enterQuestion(nextQ);
			else optionIndex = 0;
			refresh();
		}

		function saveAnswer(qId: string, value: string, wasCustom: boolean) {
			const q = questions.find((qq) => qq.id === qId);
			answers.set(qId, { id: qId, question: q?.question ?? qId, answer: value, wasCustom });
		}

		editor.onSubmit = (value) => {
			if (!inputQuestionId) return;
			const trimmed = value.trim();
			if (!trimmed) {
				refresh();
				return;
			}
			drafts.delete(inputQuestionId);
			saveAnswer(inputQuestionId, trimmed, true);
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
			advanceAfterAnswer();
		};

		function exitEditor() {
			if (inputQuestionId) {
				const text = editor.getText();
				if (text.trim()) drafts.set(inputQuestionId, text);
				else drafts.delete(inputQuestionId);
			}
			inputMode = false;
			inputQuestionId = null;
			editor.setText("");
		}

		enterQuestion(questions[0]);

		function handleInput(data: string) {
			if (inputMode) {
				if (matchesKey(data, Key.escape)) {
					const q = currentQuestion();
					if (q && q.options.length === 0 && !isMulti) submit(true);
					else {
						exitEditor();
						refresh();
					}
					return;
				}
				if (isMulti && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
					exitEditor();
					currentTab = matchesKey(data, Key.tab) ? (currentTab + 1) % totalTabs : (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}

			const q = currentQuestion();
			const opts = displayOptions();

			if (isMulti) {
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.right)) {
					currentTab = (currentTab + 1) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
					return;
				}
				if (matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left)) {
					currentTab = (currentTab - 1 + totalTabs) % totalTabs;
					const nextQ = currentQuestion();
					if (nextQ) enterQuestion(nextQ);
					else optionIndex = 0;
					refresh();
					return;
				}
			}

			if (currentTab === questions.length) {
				if (matchesKey(data, Key.enter) && allAnswered()) submit(false);
				else if (matchesKey(data, Key.escape)) submit(true);
				return;
			}

			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(opts.length - 1, optionIndex + 1);
				refresh();
				return;
			}

			if (matchesKey(data, Key.enter) && q) {
				if (q.options.length === 0 || opts[optionIndex]?.isCustom) {
					inputMode = true;
					inputQuestionId = q.id;
					const draft = drafts.get(q.id);
					const existing = answers.get(q.id);
					editor.setText(draft ?? (existing?.wasCustom ? existing.answer : ""));
					refresh();
					return;
				}
				const opt = opts[optionIndex];
				if (opt) {
					saveAnswer(q.id, opt.label, false);
					advanceAfterAnswer();
				}
				return;
			}

			if (matchesKey(data, Key.escape)) submit(true);
		}

		function render(width: number): string[] {
			if (cachedLines) return cachedLines;
			const safeWidth = Math.max(20, width);
			const lines: string[] = [];
			const q = currentQuestion();
			const opts = displayOptions();
			const add = (s: string) => lines.push(truncateToWidth(s, safeWidth, "…", true));
			const addWrapped = (s: string) => lines.push(...wrapTextWithAnsi(s, safeWidth));

			add(theme.fg("accent", "─".repeat(safeWidth)));
			if (isMulti) {
				const tabs: string[] = ["← "];
				for (let i = 0; i < questions.length; i++) {
					const isActive = i === currentTab;
					const isAnswered = answers.has(questions[i].id);
					const label = ` ${isAnswered ? "■" : "□"} ${questions[i].id} `;
					tabs.push(isActive ? theme.bg("selectedBg", theme.fg("text", label)) : theme.fg(isAnswered ? "success" : "muted", label));
					tabs.push(" ");
				}
				const submitText = " ✓ Submit ";
				tabs.push(currentTab === questions.length ? theme.bg("selectedBg", theme.fg("text", submitText)) : theme.fg(allAnswered() ? "success" : "dim", submitText));
				tabs.push(" →");
				add(` ${tabs.join("")}`);
				lines.push("");
			}

			function renderOptions() {
				for (let i = 0; i < opts.length; i++) {
					const opt = opts[i];
					const selected = i === optionIndex;
					const prefix = selected ? theme.fg("accent", "> ") : "  ";
					const recTag = !opt.isCustom && q?.recommended === i ? theme.fg("success", " ★") : "";
					add(prefix + theme.fg(selected ? "accent" : "text", `${i + 1}. ${opt.label}`) + recTag);
				}
			}

			if (inputMode && q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				if (q.context) addWrapped(theme.fg("muted", ` ${q.context}`));
				lines.push("");
				if (q.options.length > 0) {
					renderOptions();
					lines.push("");
				}
				add(theme.fg("muted", " Your answer:"));
				for (const line of editor.render(safeWidth - 2)) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter to submit • Esc to cancel"));
			} else if (currentTab === questions.length) {
				add(theme.fg("accent", theme.bold(" Ready to submit")));
				lines.push("");
				for (const question of questions) {
					const answer = answers.get(question.id);
					add(`${theme.fg("muted", ` ${question.id}: `)}${answer ? theme.fg("text", `${answer.wasCustom ? "(wrote) " : ""}${answer.answer}`) : theme.fg("warning", "(unanswered)")}`);
				}
				lines.push("");
				add(allAnswered() ? theme.fg("success", " Press Enter to submit") : theme.fg("warning", ` Unanswered: ${questions.filter((qq) => !answers.has(qq.id)).map((qq) => qq.id).join(", ")}`));
			} else if (q) {
				addWrapped(theme.fg("text", ` ${q.question}`));
				if (q.context) addWrapped(theme.fg("muted", ` ${q.context}`));
				const existing = answers.get(q.id);
				if (existing) add(theme.fg("dim", ` Current: ${existing.wasCustom ? "(wrote) " : ""}${existing.answer}`));
				lines.push("");
				if (opts.length > 0) renderOptions();
				else add(theme.fg("muted", " Press Enter to write your answer"));
			}

			lines.push("");
			if (!inputMode) add(theme.fg("dim", isMulti ? " Tab/←→ navigate • ↑↓ select • Enter confirm • Esc cancel" : " ↑↓ navigate • Enter select • Esc cancel"));
			add(theme.fg("accent", "─".repeat(safeWidth)));
			cachedLines = lines;
			return lines;
		}

		return { render, invalidate: () => { cachedLines = undefined; }, handleInput };
	});
}

/**
 * Confirm a proposed draft through the shared questionnaire UI. Escape / cancel
 * maps to "continue" so the user is never trapped.
 */
export async function showProposalDialog(
	ctx: ExtensionContext,
	confirmationText: string,
	focus: GoalDraftingFocus,
): Promise<ProposalDecision> {
	const headerTitle = focus === "sisyphus" ? "Confirm Sisyphus Goal Draft" : "Confirm Goal Draft";
	const result = await runGoalQuestionnaire(ctx, [{
		id: "confirm",
		question: headerTitle,
		context: confirmationText,
		options: ["Confirm — create this goal now", "Continue chatting — keep refining"],
		recommended: 0,
		allowCustom: false,
	}]);
	return proposalDecisionFromQuestionnaireResult({
		cancelled: result.cancelled,
		answer: result.answers[0]?.answer,
	});
}

export function registerQuestionnaireTools(pi: ExtensionAPI): void {
	pi.registerTool(defineTool({
		name: QUESTION_TOOL_NAME,
		label: "goal_question",
		description:
			"Ask the user a focused single question through pi-goal's built-in goal_question UI. " +
			"This is the single-question alias for goal_questionnaire and is allowed during drafting.",
		promptSnippet: "Ask the user a focused question with optional choices.",
		promptGuidelines: [
			"Use goal_question when exactly one user decision is required before proceeding.",
			"During drafting this is allowed; it returns user Q&A into the conversation and is not task execution.",
			"Prefer concise options. Use allowFreeText=false only when the user must pick from fixed choices.",
		],
		parameters: Type.Object({
			question: Type.String({ description: "Question to ask the user." }),
			context: Type.Optional(Type.String({ description: "Short context explaining why the answer is needed." })),
			options: Type.Optional(Type.Array(Type.String({ description: "Suggested answer option." }))),
			recommended: Type.Optional(Type.Integer({ minimum: 0, description: "0-based index of the recommended option." })),
			allowFreeText: Type.Optional(Type.Boolean({ description: "Allow the user to write a custom answer. Defaults to true." })),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Headless mode: the question was recorded, but no interactive UI answer was collected. If the original request is already fully specified, proceed with the documented/default assumption; otherwise ask the user in final text and stop." }],
					details: { questions: [], answers: [], cancelled: true, answer: undefined },
				};
			}

			const result = await runGoalQuestionnaire(ctx, [{
				id: "answer",
				question: params.question,
				context: params.context,
				options: params.options ?? [],
				recommended: params.recommended,
				allowCustom: params.allowFreeText ?? true,
			}]);

			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "User cancelled the question." }],
					details: { ...result, answer: undefined },
				};
			}

			const answer = result.answers[0]?.answer ?? "";
			return {
				content: [{ type: "text", text: `User answered: ${answer}` }],
				details: { ...result, answer },
			};
		},
		renderCall(args, theme) {
			return new Text(theme.fg("toolTitle", theme.bold("goal_question ")) + theme.fg("muted", truncateText(args?.question ?? "", 80)), 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as { answer?: string; cancelled?: boolean } | undefined;
			if (details?.cancelled) return new Text(theme.fg("warning", "(cancelled)"), 0, 0);
			if (details?.answer !== undefined) return new Text(theme.fg("success", "✓ ") + theme.fg("muted", details.answer), 0, 0);
			const text = result.content[0];
			return new Text(text?.type === "text" ? text.text : "", 0, 0);
		},
	}));

	pi.registerTool(defineTool({
		name: QUESTIONNAIRE_TOOL_NAME,
		label: "goal_questionnaire",
		description:
			"Ask the user one or more questions via pi-goal's built-in goal_questionnaire UI. " +
			"Use this during drafting when you need structured grill/Q&A before propose_goal_draft; " +
			"batch related questions into one call. Returns Q&A records in the conversation history.",
		promptSnippet: "Ask the user one or more structured questions with choices and optional free-text answers.",
		promptGuidelines: [
			"Use goal_questionnaire when a user decision or missing requirement blocks a concrete draft.",
			"During /goal-set or /goal-sisyphus drafting, goal_questionnaire is allowed; workhorse/reconnaissance tools are not.",
			"Prefer 1-3 focused questions. Batch related choices in one questionnaire call instead of repeatedly interrupting the user.",
			"Use recommended to mark the best default choice when there is one. Set allowCustom=false only for strict binary/choice prompts such as confirmation.",
		],
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					id: Type.String({ description: "Short stable identifier, e.g. 'scope', 'success', 'constraints'." }),
					question: Type.String({ description: "The question to ask the user." }),
					context: Type.Optional(Type.String({ description: "Optional background, trade-offs, or why the answer matters." })),
					options: Type.Optional(Type.Array(Type.String({ description: "Suggested answer option." }), { description: "Suggested answers. Free-text is still available unless allowCustom=false." })),
					recommended: Type.Optional(Type.Integer({ minimum: 0, description: "0-based index of the recommended option. Shown with a star and selected by default." })),
					allowCustom: Type.Optional(Type.Boolean({ description: "Allow the user to write a custom answer. Defaults to true." })),
				}),
				{ minItems: 1 },
			),
		}),
		executionMode: "sequential",
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text", text: "Headless mode: the questions were recorded, but no interactive UI answers were collected. If the original request is already fully specified, proceed with documented/default assumptions; otherwise ask the user in final text and stop." }],
					details: { questions: [], answers: [], cancelled: true } satisfies GoalQuestionnaireResult,
				};
			}

			const rawQuestions = params.questions.map((q) => ({
				id: q.id,
				question: q.question,
				context: q.context,
				options: q.options ?? [],
				recommended: q.recommended,
				allowCustom: q.allowCustom ?? true,
			}));

			const result = await runGoalQuestionnaire(ctx, rawQuestions);
			if (result.cancelled) {
				return {
					content: [{ type: "text", text: "(goal_questionnaire dismissed)" }],
					details: result,
				};
			}

			return {
				content: [{ type: "text", text: formatQuestionnaireAnswers(result) }],
				details: result,
			};
		},
		renderCall(args, theme) {
			const qs = (args.questions as Array<{ id: string; question: string }>) || [];
			const labels = qs.map((q) => q.id).join(", ");
			let text = theme.fg("toolTitle", theme.bold("goal_questionnaire "));
			text += theme.fg("muted", `${qs.length} question${qs.length !== 1 ? "s" : ""}`);
			if (labels) text += theme.fg("dim", ` (${truncateToWidth(labels, 40)})`);
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as GoalQuestionnaireResult | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.cancelled) return new Text(theme.fg("warning", "(dismissed)"), 0, 0);
			const lines = details.answers.map((answer) => {
				const prefix = answer.wasCustom ? "(wrote) " : "";
				return `${theme.fg("success", "✓ ")}${theme.fg("accent", answer.id)}: ${theme.fg("muted", prefix)}${answer.answer}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	}));
}
