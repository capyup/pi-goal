#!/usr/bin/env node
/**
 * harness/drive.mjs
 *
 * Drive a pi AgentSession via the SDK so that:
 *   1. Slash commands fire and their queued continuation turn actually runs
 *      (which `pi -p "/slash"` does NOT wait for; -p exits as soon as the
 *      handler returns, leaving sendMessage-queued turns un-drained).
 *   2. We can chain multiple turns deterministically without --continue.
 *   3. The extension under test is the only loaded extension.
 *
 * NDJSON event stream is written to stdout, matching the `pi --mode json`
 * shape closely enough for extract.sh / grade.sh to consume.
 *
 * Usage:
 *   drive.mjs <case-dir> <run-dir>
 *
 * Required env:
 *   PI_GOAL_TEST_EXTENSION    abs path to extension file
 *   PI_GOAL_TEST_PROVIDER     provider id (e.g. openrouter, fireworks)
 *   PI_GOAL_TEST_MODEL        model id
 *   PI_GOAL_TEST_THINKING     off | low | medium | high
 *   PI_GOAL_TEST_TURN_TIMEOUT seconds (per session.prompt call), default 180
 *
 * INPUT.md format: lines that begin with "TURN: " are user prompts (one per line).
 * Lines beginning with "#" or empty are ignored.
 */

import { readFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

const [, , caseDirArg, runDirArg] = process.argv;
if (!caseDirArg || !runDirArg) {
	console.error("usage: drive.mjs <case-dir> <run-dir>");
	process.exit(2);
}

const caseDir = resolve(caseDirArg);
const runDir = resolve(runDirArg);
const sandboxDir = join(runDir, "sandbox");
const sessionDir = join(runDir, "sessions");
mkdirSync(sandboxDir, { recursive: true });
mkdirSync(sessionDir, { recursive: true });

// Per-case env overrides via <case-dir>/env.json. Loaded BEFORE the extension
// is imported so module-load-time env reads (e.g. PI_GOAL_MAX_AUTOCONTINUE_TURNS)
// pick them up. Use this to tweak extension constants at test time.
try {
	const envPath = join(caseDir, "env.json");
	const raw = readFileSync(envPath, "utf8");
	const parsed = JSON.parse(raw);
	if (parsed && typeof parsed === "object") {
		for (const [k, v] of Object.entries(parsed)) {
			process.env[k] = String(v);
		}
		console.error(`[drive] case env applied: ${JSON.stringify(parsed)}`);
	}
} catch {
	// no per-case env override
}

const extPath = process.env.PI_GOAL_TEST_EXTENSION;
const provider = process.env.PI_GOAL_TEST_PROVIDER || "openrouter";
const modelId = process.env.PI_GOAL_TEST_MODEL || "moonshotai/kimi-k2.6";
const thinking = process.env.PI_GOAL_TEST_THINKING || "high";
const turnTimeoutMs = Number(process.env.PI_GOAL_TEST_TURN_TIMEOUT || "180") * 1000;
if (!extPath) {
	console.error("PI_GOAL_TEST_EXTENSION env is required");
	process.exit(2);
}

// Parse INPUT.md → array of {kind:"turn", text} or {kind:"sleep", ms}.
const inputPath = join(caseDir, "INPUT.md");
const inputText = readFileSync(inputPath, "utf8");
const turns = [];
for (const line of inputText.split(/\r?\n/)) {
	if (line.startsWith("TURN: ")) {
		turns.push({ kind: "turn", text: line.slice("TURN: ".length) });
	} else if (/^SLEEP:\s*(\d+)/.test(line)) {
		turns.push({ kind: "sleep", ms: Number(RegExp.$1) });
	} else if (/^ABORT_AFTER_MS:\s*(\d+)/.test(line)) {
		// Schedule a session.abort() N ms after the next TURN starts. Tests the
		// goal extension's pauseForAbort code path (B4).
		turns.push({ kind: "abort_after_ms", ms: Number(RegExp.$1) });
	}
}
if (turns.length === 0) {
	console.error("INPUT.md has no 'TURN: <prompt>' lines");
	process.exit(2);
}

// Run pi in the sandbox so disk-backed extension artifacts (.pi/goals/) land there.
process.chdir(sandboxDir);

const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

let model = modelRegistry.find(provider, modelId);
if (!model) {
	// CLI behaviour: when --provider X --model Y but Y is not a known built-in or
	// custom model under provider X, pi constructs a "custom model id" — taking
	// the shape of any same-provider model and overriding id+name. We replicate
	// that here for fireworks router IDs etc. See pi's buildFallbackModel().
	const sameProvider = modelRegistry.getAll().filter((m) => m.provider === provider);
	if (sameProvider.length === 0) {
		console.error(`No models available for provider "${provider}". Cannot build fallback.`);
		process.exit(2);
	}
	const base = sameProvider[0];
	model = { ...base, id: modelId, name: modelId };
	console.error(`[drive] Model "${provider}/${modelId}" not in registry; using custom model id (base=${base.id}).`);
}

// Custom settings: disable compaction (tests are short, we don't want auto-compact
// kicking in mid-test and confusing the rubric). A case can opt in to compaction
// by dropping a `compaction.json` file in its case dir, e.g.:
//   { "enabled": true, "thresholdTokens": 4000 }
let compactionConfig = { enabled: false };
try {
	const compactionPath = join(caseDir, "compaction.json");
	const raw = readFileSync(compactionPath, "utf8");
	const parsed = JSON.parse(raw);
	if (parsed && typeof parsed === "object" && parsed.enabled === true) {
		compactionConfig = parsed;
		console.error(`[drive] case-level compaction enabled: ${JSON.stringify(parsed)}`);
	}
} catch {
	// no override; keep default disabled
}
const settingsManager = SettingsManager.inMemory({
	compaction: compactionConfig,
	retry: { enabled: true, maxRetries: 2 },
});

// Custom agent dir to avoid leaking host's ~/.pi extensions/skills/themes.
// Make it empty + isolated to this run.
const agentDir = join(runDir, "agent-dir");
mkdirSync(agentDir, { recursive: true });

const resourceLoader = new DefaultResourceLoader({
	cwd: sandboxDir,
	agentDir,
	settingsManager,
	additionalExtensionPaths: [extPath],
	noExtensions: false, // we want extensions, but default discovery is empty (agentDir is fresh)
	noSkills: true,
	noPromptTemplates: true,
	noThemes: true,
	noContextFiles: true,
});
await resourceLoader.reload();

// Surface extension load errors loud and clear.
const extInfo = resourceLoader.getExtensions();
for (const e of extInfo.errors) {
	console.error(`[drive] extension load error: ${e.path}: ${e.error}`);
}
if (extInfo.extensions.length === 0) {
	console.error("[drive] no extensions loaded — extension load probably failed silently");
	process.exit(2);
}

// Persistent session under the run dir so we can inspect after.
const sessionManager = SessionManager.create(sandboxDir, sessionDir);

const { session, modelFallbackMessage } = await createAgentSession({
	cwd: sandboxDir,
	agentDir,
	model,
	thinkingLevel: thinking,
	authStorage,
	modelRegistry,
	resourceLoader,
	sessionManager,
	settingsManager,
});

if (modelFallbackMessage) {
	console.error(`[drive] modelFallback: ${modelFallbackMessage}`);
}

// Emit a synthetic `session` event up front to match `pi --mode json` shape.
const emit = (obj) => {
	process.stdout.write(JSON.stringify(obj) + "\n");
};

emit({
	type: "session",
	version: 3,
	id: session.sessionId,
	timestamp: new Date().toISOString(),
	cwd: sandboxDir,
});

const unsubscribe = session.subscribe((event) => {
	try {
		emit(event);
	} catch (err) {
		console.error(`[drive] failed to emit event: ${err?.message || err}`);
	}
});

let aborted = false;

// Slash command handlers in this extension call pi.sendMessage(..., {triggerTurn:true})
// fire-and-forget. session.prompt("/cmd") therefore resolves before the queued
// triggered turn finishes. To capture the full effect of a slash command we wait
// until *all* triggered work is quiescent: isStreaming = false and no new
// turn_start within a quiet window after the last turn_end.
let lastTurnActivityAt = Date.now();
let inFlightTurns = 0;
session.subscribe((e) => {
	if (e.type === "turn_start") {
		inFlightTurns += 1;
		lastTurnActivityAt = Date.now();
	} else if (e.type === "turn_end") {
		inFlightTurns = Math.max(0, inFlightTurns - 1);
		lastTurnActivityAt = Date.now();
	} else if (e.type === "agent_start" || e.type === "agent_end") {
		lastTurnActivityAt = Date.now();
	}
});

// Quiet-window for "no more chained activity". Slash commands (sendMessage with
// triggerTurn) queue follow-up turns that fire-and-forget AFTER prompt() resolves.
// autoContinue also fires another turn ~50ms after each turn_end. The window
// must be large enough to capture LLM RTT before the next turn_start event,
// otherwise the harness exits between an autoContinue chain's links. 400ms was
// too tight for sisyphus goals where the schema forces turn-per-step
// (step_complete) execution. We use a goal-aware policy: while a goal is
// active+autoContinue, we keep waiting (with a generous ceiling); only when the
// goal goes paused/complete/missing do we fall back to the short quiet window.
const QUIET_MS = Number(process.env.PI_GOAL_QUIET_MS || "5000");
const POLL_MS = 50;

function readActiveGoal() {
	// The extension persists the goal record under .pi/goals/active_goal_*.md
	// (in CWD). We sniff that file to check if autoContinue is still chasing
	// the objective so the harness can wait through inter-turn LLM RTT.
	try {
		const dir = ".pi/goals";
		const list = readdirSync(dir);
		for (const name of list) {
			if (!name.startsWith("active_goal_") || !name.endsWith(".md")) continue;
			const content = readFileSync(join(dir, name), "utf8");
			const end = content.indexOf("\n}");
			if (end < 0) continue;
			const json = content.slice(0, end + 2);
			try {
				const obj = JSON.parse(json);
				return obj;
			} catch { /* fall through */ }
		}
	} catch { /* dir missing or unreadable */ }
	return null;
}

async function waitForQuiescence(deadline) {
	// Settling strategy: after the last turn_end, we wait QUIET_MS. If a new
	// turn starts during that window (slash-command follow-up or autoContinue
	// continuation), the timer resets. Additionally, while the goal is still
	// active+autoContinue, we extend waiting until the next turn fires or the
	// deadline hits — this captures the LLM RTT gap between turns.
	while (Date.now() < deadline) {
		const idle = !session.isStreaming && inFlightTurns === 0;
		const sinceActivity = Date.now() - lastTurnActivityAt;
		if (idle && sinceActivity >= QUIET_MS) {
			// Quiet window elapsed. But if the goal is still actively chasing
			// autoContinue, give it more time — the next turn may just be slow
			// to start (LLM cold start, large prompt, etc.).
			const g = readActiveGoal();
			if (!g || g.status !== "active" || g.autoContinue === false) return true;
			// Goal is still active+autoContinue. Wait up to deadline for the
			// next turn_start. The deadline acts as the upper bound.
		}
		await new Promise((r) => setTimeout(r, POLL_MS));
	}
	return false;
}

const promptWithTimeout = async (text, idx, opts = {}) => {
	const start = Date.now();
	emit({ type: "_turn_marker", index: idx, prompt: text });
	const deadline = Date.now() + turnTimeoutMs;
	lastTurnActivityAt = Date.now();
	let abortTimer = null;
	if (opts.abortAfterMs && opts.abortAfterMs > 0) {
		emit({ type: "_drive_abort_armed", index: idx, after_ms: opts.abortAfterMs });
		abortTimer = setTimeout(() => {
			emit({ type: "_drive_abort_scheduled", index: idx, after_ms: opts.abortAfterMs });
			try {
				session.abort();
			} catch (e) {
				emit({ type: "_drive_abort_error", index: idx, error: String(e?.message || e) });
			}
		}, opts.abortAfterMs);
	}
	try {
		const promptResult = session.prompt(text);
		// Race prompt completion against timeout; we also want to drain triggered
		// turns even after prompt() resolves.
		await Promise.race([
			promptResult,
			new Promise((_, rej) => setTimeout(() => rej(new Error("prompt timeout")), turnTimeoutMs)),
		]);
		// Now wait for the system to actually go quiet (slash commands trigger
		// background turns; we want those captured before moving on).
		await waitForQuiescence(deadline);
	} catch (err) {
		emit({ type: "_drive_error", index: idx, message: String(err?.message || err) });
		if (String(err?.message || "").includes("timeout")) {
			aborted = true;
			session.abort().catch(() => {});
		}
	} finally {
		if (abortTimer) clearTimeout(abortTimer);
	}
	const elapsed = Date.now() - start;
	emit({ type: "_turn_done", index: idx, elapsed_ms: elapsed });
};

try {
	let idx = 0;
	let pendingAbortMs = 0;
	for (const t of turns) {
		if (aborted) break;
		if (t.kind === "turn") {
			idx += 1;
			await promptWithTimeout(t.text, idx, { abortAfterMs: pendingAbortMs });
			pendingAbortMs = 0;
		} else if (t.kind === "sleep") {
			await new Promise((r) => setTimeout(r, t.ms));
		} else if (t.kind === "abort_after_ms") {
			pendingAbortMs = t.ms;
		}
	}
} finally {
	unsubscribe();
	try {
		session.dispose();
	} catch {}
}

process.exit(aborted ? 124 : 0);
