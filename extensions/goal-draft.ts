import { isQuestionLikeToolName } from "./goal-tool-names.ts";

export type GoalDraftingFocus = "goal" | "sisyphus";

export interface DraftingStateLike {
	focus: GoalDraftingFocus;
	originalTopic: string;
	questionsAsked: number;
	draftId?: string;
}

export interface DraftProposalInput {
	drafting: DraftingStateLike | null;
	hasUnfinishedGoal: boolean;
	objective: string;
	sisyphus?: boolean;
	draftId?: string;
}

export type DraftProposalValidation =
	| { ok: true; objective: string; expectedSisyphus: boolean }
	| { ok: false; message: string; clearDrafting?: boolean };

export type ToolGateDecision =
	| { block: false }
	| { block: true; reason: string };

export function promptSafeObjective(objective: string): string {
	return objective.replace(/<\/?untrusted_objective>/gi, (tag) => tag.replace(/</g, "&lt;").replace(/>/g, "&gt;"));
}

export function buildDraftConfirmationText(args: {
	focus: GoalDraftingFocus;
	originalTopic: string;
	objective: string;
	autoContinue: boolean;
	tokenBudget: number | null;
}): string {
	const lines: string[] = [];
	const modeLabel = args.focus === "sisyphus" ? "Sisyphus (prompt/criteria style)" : "Normal goal";
	lines.push("Goal draft ready for confirmation.");
	lines.push("");
	lines.push("Draft details:");
	lines.push(`Mode: ${modeLabel}`);
	lines.push(`Auto-continue: ${args.autoContinue ? "yes" : "no"}`);
	if (args.tokenBudget !== null) {
		lines.push(`Token budget: ${args.tokenBudget.toLocaleString("en-US")}`);
	}
	lines.push("");
	lines.push("Original topic:");
	lines.push("");
	lines.push(args.originalTopic.trim());
	lines.push("");
	lines.push("Proposed goal:");
	lines.push("");
	lines.push(args.objective);
	return lines.join("\n");
}

export function evaluateDraftingToolGate(args: {
	toolName: string;
	draftingFocus?: GoalDraftingFocus | null;
	tweakDraftingGoalId?: string | null;
	activeGoalId?: string | null;
	proposeToolName?: string;
	tweakApplyToolName?: string;
	getGoalToolName?: string;
}): ToolGateDecision {
	const proposeToolName = args.proposeToolName ?? "propose_goal_draft";
	const tweakApplyToolName = args.tweakApplyToolName ?? "apply_goal_tweak";
	const getGoalToolName = args.getGoalToolName ?? "get_goal";
	if (args.draftingFocus) {
		if (args.toolName !== proposeToolName && args.toolName !== getGoalToolName && !isQuestionLikeToolName(args.toolName)) {
			return {
				block: true,
				reason: `Drafting is in progress (focus=${args.draftingFocus}). During /goal-set or /goal-sisyphus drafting, you may ask/clarify via plain chat or any question-like user-dialogue tool, may call get_goal for read-only state, and may call propose_goal_draft to commit. DO NOT use bash, read, write, edit, grep, find, ls, or any other workhorse tool.`,
			};
		}
	}
	if (args.tweakDraftingGoalId && args.activeGoalId && args.tweakDraftingGoalId === args.activeGoalId) {
		if (args.toolName !== tweakApplyToolName && args.toolName !== getGoalToolName && !isQuestionLikeToolName(args.toolName)) {
			return {
				block: true,
				reason: `Tweak drafting is in progress for goal ${args.tweakDraftingGoalId}. You may ask/clarify via plain chat or any question-like user-dialogue tool, may call get_goal for read-only state, and may call apply_goal_tweak to commit. DO NOT use bash, read, write, edit, or any workhorse tool.`,
			};
		}
	}
	return { block: false };
}

export function validateDraftPromptIdentity(args: { incomingDraftId: string | null; activeDraftId: string | null }): ToolGateDecision {
	if (args.incomingDraftId === null) return { block: false };
	if (args.activeDraftId === args.incomingDraftId) return { block: false };
	return {
		block: true,
		reason: `Stale goal drafting prompt ignored (draftId=${args.incomingDraftId}). The active drafting flow is ${args.activeDraftId ?? "none"}; do not propose or create a goal from this stale prompt.`,
	};
}

export function validateGoalDraftProposal(input: DraftProposalInput): DraftProposalValidation {
	if (input.drafting === null) {
		return {
			ok: false,
			message: "propose_goal_draft REJECTED: no /goal-set or /goal-sisyphus drafting is in progress. Tell the user to invoke /goal-set <topic> or /goal-sisyphus <topic> first.",
		};
	}
	if (input.drafting.questionsAsked < 1) {
		return {
			ok: false,
			message: "propose_goal_draft REJECTED (B0 question gate): before proposing a goal, you must ask the user at least one concrete question about objective, measurable success criteria, constraints, boundaries, priority, or blocker handling. Use goal_question or goal_questionnaire, then incorporate the answer and retry.",
		};
	}

	const expectedSisyphus = input.drafting.focus === "sisyphus";
	if (input.draftId !== undefined && input.drafting.draftId !== undefined && input.draftId !== input.drafting.draftId) {
		return {
			ok: false,
			message: `propose_goal_draft REJECTED (stale draft): active draftId is ${input.drafting.draftId}, but you passed ${input.draftId}. Ask the user to restart drafting if this was intentional.`,
		};
	}
	const actualSisyphus = input.sisyphus === true;
	if (actualSisyphus !== expectedSisyphus) {
		return {
			ok: false,
			message: `propose_goal_draft REJECTED (B1 focus gate): drafting focus is "${input.drafting.focus}" (user invoked ${input.drafting.focus === "sisyphus" ? "/goal-sisyphus" : "/goal-set"}) but you passed sisyphus=${actualSisyphus}. Set sisyphus=${expectedSisyphus} to match the user's choice, then retry. Do NOT change the user's mode autonomously.`,
		};
	}

	const objective = input.objective.trim();
	if (!objective) {
		return { ok: false, message: "propose_goal_draft REJECTED: objective is empty." };
	}

	return { ok: true, objective, expectedSisyphus };
}

export function goalDraftingPrompt(topic: string, focus: GoalDraftingFocus, draftId?: string): string {
	const safeTopic = promptSafeObjective(topic.trim() || "(no topic provided — ask the user what they want to accomplish)");
	const draftAttr = draftId ? ` draftId=${draftId}` : "";
	const header = focus === "sisyphus"
		? `[GOAL DRAFTING focus=sisyphus${draftAttr}]\nThe user invoked Sisyphus mode (/goal-sisyphus). You are entering a drafting interview. Do NOT start the work yet.`
		: `[GOAL DRAFTING focus=goal${draftAttr}]\nThe user invoked /goal-set with a topic. You are entering a drafting interview. Do NOT start the work yet.`;

	const commonProtocol = [
		"Drafting protocol — grill-me style, one branch at a time:",
		"- You MUST ask the user at least one concrete question before calling propose_goal_draft. This is required even if the topic already looks complete. The runtime rejects proposals until a question-like tool has been used.",
		"- The required question MUST be asked with goal_question or goal_questionnaire. Do not merely write a question in normal assistant text; plain text does not satisfy the runtime gate and leaves drafting stuck.",
		"- If the topic is already concrete, ask one minimal calibration question with a recommended default, then immediately call propose_goal_draft. Do not end the turn with optional preference questions about implementation details such as timeout/retry policy when the user's blocker rule is already clear.",
		"- Ask exactly one decision-oriented question at a time. Target assumptions, measurable success criteria, constraints, boundaries, priorities, risks, trade-offs, unresolved dependencies, or blocker handling.",
		"- Provide a recommended answer with the question: a concrete proposal the user can accept, reject, or modify. Avoid rhetorical or broad open-ended questions.",
		"- Prefer goal_question for the required first grill because it supports a focused question plus recommended options. Use goal_questionnaire only when one UI interaction genuinely needs multiple tightly related choices.",
		"- Resolve dependencies in order. Do not jump to downstream implementation details until the current decision branch is settled.",
		"- Aim to converge in 1-3 rounds of Q&A. Do not drag drafting out after the required question has resolved the contract.",
		"- Drafting is a CONVERSATION with the user, not reconnaissance. Do NOT call workhorse tools during drafting — not bash, not read, not grep, not find, not ls, not write, not edit, not pause_goal, not Todo. The runtime treats goal_question, goal_questionnaire, question, questionnaire, and other question-like user-dialogue tools as asking the user, not doing task work.",
		"- If you need to know something about the codebase or filesystem to ask a sharper question, ASK THE USER instead. The user is your source of truth during goal drafting; get_goal is the only read-only state tool allowed.",
		"- The only task-affecting tool you may call during drafting is propose_goal_draft, and only after the required question plus the items below are clear. Before that, you may ask/clarify via question-like tools; get_goal is allowed for read-only state. If the topic is impossibly vague (e.g. empty), ask the user for the topic itself; do not call propose_goal_draft with placeholder content.",
		"- Do not call propose_goal_draft until the items below are clear from the original topic plus your Q&A.",
		"- propose_goal_draft will show the user a [Confirm] / [Continue Chatting] dialog. If they Confirm, the goal is created. If they Continue Chatting, you go back to interviewing them. There is no 'create_goal' shortcut anymore; everything goes through propose_goal_draft.",
		"- IMPORTANT for Sisyphus: do NOT add reconnaissance / verification / preflight / 'check that X exists' steps that the user did not ask for. Use the user's requested order/style as-is. Sisyphus is a prompt/criteria variant, not a separate step-counter mechanism.",
	];

	const goalFocusItems = [
		"Drafting focus for /goal — establish:",
		"  1. The objective: what the user actually wants to accomplish, restated as a concrete, verifiable outcome (not a vague theme).",
		"  2. The completion / success criteria: what observable evidence proves the goal is done. Tests passing, file existing, command output, behavior change, etc.",
		"  3. The boundaries: what is in scope, what is explicitly out of scope, what should NOT be touched or changed.",
		"  4. Hard constraints: deadlines, performance requirements, compatibility, files/areas that must remain untouched, style rules.",
		"  5. Failure / blocker handling: when blocked, default to stop-and-ask unless the user says otherwise.",
	];

	const sisyphusFocusItems = [
		"Drafting focus for /goal-sisyphus — establish everything /goal would (objective, criteria, boundaries, constraints, blocker handling) PLUS:",
		"  A. The ordered execution style the user wants: patient, sequential, no rushing, no unrequested reconnaissance.",
		"  B. Any user-provided ordered plan, preserved as numbered task steps with the same step count; do not collapse, expand, or add extra mechanism steps.",
		"  C. The completion standard: what evidence proves the whole objective is actually done.",
		"  D. Failure rule: when blocked or unclear, default to stop-and-ask the user; do not improvise workarounds.",
		"  E. Note: Sisyphus mode is a prompt/criteria style. It shares the same lifecycle and tools as a regular goal.",
	];

	const createGoalShape = focus === "sisyphus"
		? [
			"When the items above are clear, summarize the plan back to the user in one short message and call propose_goal_draft with:",
			"  - sisyphus: true (REQUIRED — schema rejects sisyphus=false during /goal-sisyphus drafting)",
		"  - autoContinue: true (unless the user explicitly asked to drive manually)",
		...(draftId ? [`  - draftId: ${draftId} (REQUIRED — schema rejects stale overlapping drafts)`] : []),
		"  - objective: the FULL plan formatted like this (verbatim, including the section headers):",
			"",
			"    === Sisyphus Goal ===",
			"    Objective: <one-sentence outcome>",
			"    Success criteria: <observable evidence the goal is done>",
			"    Boundaries: <in scope / out of scope>",
			"    Constraints: <hard rules, files not to touch, etc.>",
			"    Ordered steps: <if the user provided or implied ordered work, list exactly those task steps as 1. 2. ...; preserve the user's step count and do not add verification/preflight/recon steps>",
			"    If blocked / unclear / failing: <rule, default = stop and ask the user>",
			"    Sisyphus reminder: Work patiently and sequentially. No rushing, no unrequested preflight steps, no improvising around blockers.",
			"",
			"After the user confirms in the dialog, the goal becomes active and a continuation will arrive. Begin work then. Not before. If the user picks 'Continue Chatting' instead, ask them what to revise.",
		]
		: [
			"When the items above are clear, summarize the plan back to the user in one short message and call propose_goal_draft with:",
			"  - objective: the FULL plan formatted like this (verbatim, including the section headers):",
			"",
			"    === Goal ===",
			"    Objective: <one-sentence outcome>",
			"    Success criteria: <observable evidence the goal is done>",
			"    Boundaries: <in scope / out of scope>",
			"    Constraints: <hard rules>",
			"    If blocked: <default = stop and ask the user>",
			"",
		"  - autoContinue: true (unless the user explicitly asked to drive manually)",
		...(draftId ? [`  - draftId: ${draftId} (REQUIRED — schema rejects stale overlapping drafts)`] : []),
		"  - sisyphus: false (REQUIRED — schema rejects sisyphus=true during /goal-set drafting; use /goal-sisyphus for Sisyphus)",
			"",
			"After the user confirms in the dialog, the goal becomes active and a continuation will arrive. Begin work then. Not before. If the user picks 'Continue Chatting' instead, ask them what to revise.",
		];

	return [
		header,
		"",
		"Topic the user provided (may be empty):",
		"<sisyphus_topic>",
		safeTopic,
		"</sisyphus_topic>",
		"",
		...commonProtocol,
		"",
		...(focus === "sisyphus" ? sisyphusFocusItems : goalFocusItems),
		"",
		...createGoalShape,
		"",
		"Edge cases:",
		"- If the user truly cannot specify some item, propose a reasonable default and ask them to confirm or override.",
		"- If the user says 'just go' or 'you decide': still ask one grill-me style decision question, then produce an explicit objective (and for Sisyphus, ordered style/completion wording) before calling propose_goal_draft. Drafting is the contract, not the bottleneck.",
		"- If, mid-drafting, you realize the request is trivial or the user already provided a complete spec inline, still ask one concise calibration question before proposing.",
		"- The user can cancel drafting at any time with /goal-clear. If they do, drafting state is reset and propose_goal_draft becomes unavailable.",
	].join("\n");
}
