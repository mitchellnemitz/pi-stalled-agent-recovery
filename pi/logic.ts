import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_MAX_RETRIES = 5;
const DEFAULT_LOOP_THRESHOLD = 5;
const DEFAULT_MAX_LOOP_NUDGES = 3;
const NOTIFY_PREFIX = "[Stalled Agent Recovery]";
const CONFIG_PATH = join(homedir(), ".pi", "agent", "stalled-agent-recovery.json");

export { NOTIFY_PREFIX };

/** customType values this extension injects via sendMessage follow-ups. */
export const FOLLOW_UP_TYPES = ["stalled-agent-recovery-loop", "stalled-agent-recovery-retry"] as const;

export function isFighterFollowUp(message: any): boolean {
	return (
		(message?.role === "user" || message?.role === "assistant") &&
		typeof message?.customType === "string" &&
		(FOLLOW_UP_TYPES as readonly string[]).includes(message.customType)
	);
}

export interface StalledAgentRecoveryConfig {
	/** Max auto-retries for empty / thinking-only responses (0 disables). */
	maxRetries: number;
	/** Identical failing tool calls at the tail before the first nudge (>= 1). */
	loopThreshold: number;
	/** Total nudges per loop before the extension stops intervening (>= 1). */
	maxLoopNudges: number;
}

export function loadConfig(path: string = CONFIG_PATH): StalledAgentRecoveryConfig {
	const defaults = { maxRetries: DEFAULT_MAX_RETRIES, loopThreshold: DEFAULT_LOOP_THRESHOLD, maxLoopNudges: DEFAULT_MAX_LOOP_NUDGES };
	try {
		if (!existsSync(path)) return defaults;
		const data = JSON.parse(readFileSync(path, "utf8"));
		return {
			maxRetries: nonNegativeIntOr(data.maxRetries, defaults.maxRetries),
			loopThreshold: positiveIntOr(data.loopThreshold, defaults.loopThreshold),
			maxLoopNudges: positiveIntOr(data.maxLoopNudges, defaults.maxLoopNudges),
		};
	} catch (err) {
		console.error(`${NOTIFY_PREFIX} Failed to read config from ${path}; using defaults:`, err);
		return defaults;
	}
}

function nonNegativeIntOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : fallback;
}

function positiveIntOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : fallback;
}

// --- stalled-response detection ------------------------------------------

export interface EmptyResponseResult {
	isEmpty: boolean;
	reason: string;
}

const TEXT_LIKE = new Set(["text", "toolCall", "tool_use", "tool_call", "functionCall"]);

function hasContent(message: any, blockType: string, textField?: string): boolean {
	const content = Array.isArray(message.content) ? message.content : [];
	return content.some((block: any) => {
		if (block?.type !== blockType) return false;
		return textField ? ((block[textField] ?? "") + "").trim().length > 0 : true;
	});
}

/**
 * Decide whether a settled run stalled. Two shapes qualify:
 * - an assistant message that produced neither output text nor a tool call
 *   (a thinking-only response is the common variant), and
 * - a bare tool result with no assistant reply after it.
 * Provider-side API errors are excluded: pi core already retries those, and
 * double-retrying here would fight it. Non-standard stop reasons
 * (length, toolUse, error) are likewise left to their own handlers.
 */
export function evaluateEmptyResponse(message: any): EmptyResponseResult {
	if (!message) return { isEmpty: false, reason: "" };

	if (message.role === "assistant") {
		if (message.errorMessage) return { isEmpty: false, reason: "" };
		const stop = message.stopReason;
		if (stop && stop !== "stop" && stop !== null && stop !== "aborted") {
			return { isEmpty: false, reason: "" };
		}

		const saidAnything = hasContent(message, "text", "text");
		const calledTools =
			(Array.isArray(message.toolCalls) && message.toolCalls.length > 0) ||
			(Array.isArray(message.content) && message.content.some((b: any) => TEXT_LIKE.has(b?.type) && b.type !== "text"));
		if (saidAnything || calledTools) return { isEmpty: false, reason: "" };

		const thoughtOnly = hasContent(message, "thinking", "thinking");
		return {
			isEmpty: true,
			reason: thoughtOnly
				? "Response only contains reasoning/thinking without output text"
				: "Assistant message is empty",
		};
	}

	if (message.role === "toolResult") {
		return { isEmpty: true, reason: "Stopped after tool execution (without assistant reply)" };
	}

	return { isEmpty: false, reason: "" };
}

// --- tool-call loop guard -------------------------------------------------

/** Key-order-independent JSON rendering, so argument objects compare by content. */
export function stableStringify(value: any): string {
	if (value === null || typeof value !== "object") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	const keys = Object.keys(value).sort();
	return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

export function toolCallSignature(call: { name: string; arguments: any }): string {
	return `${call.name}\n${stableStringify(call.arguments ?? {})}`;
}

export interface ToolLoop {
	signature: string;
	toolName: string;
	/** Identical failing calls ending at the branch tail. */
	count: number;
}

/**
 * Count the run of identical failing tool calls ending at the branch tail.
 * Returns null unless the branch ends on an error toolResult — a model that
 * already produced text after the failures has moved on and needs no nudge.
 *
 * The run is broken by a success of the same call, a changed call (same tool,
 * different arguments — legitimate iteration), or a genuine user message.
 * Results from other tools — successful or failed — do not interrupt it:
 * a failed sibling in the same batch is not the model changing approach.
 * Extension-injected follow-up messages are skipped so they cannot reset
 * the count between crossings.
 */
export function detectToolLoop(messages: any[]): ToolLoop | null {
	const last = messages[messages.length - 1];
	if (!last || last.role !== "toolResult" || !last.isError) return null;
	const firstCall = toolCallForResult(last, messages);
	if (!firstCall) return null;

	const signature = toolCallSignature(firstCall);
	let count = 1;
	for (let i = messages.length - 2; i >= 0; i--) {
		const m = messages[i];
		if (m.role === "assistant") continue;
		if (isFighterFollowUp(m)) continue;
		if (m.role === "user") break;
		if (m.role !== "toolResult") break;
		const call = toolCallForResult(m, messages);
		if (!call) break;
		if (call.name !== firstCall.name) continue; // sibling tool, not a changed call
		if (toolCallSignature(call) !== signature) break; // same tool, changed arguments
		if (!m.isError) break; // the same call succeeded: loop over
		count++;
	}
	return { signature, toolName: firstCall.name, count };
}

function toolCallForResult(result: any, messages: any[]): { name: string; arguments: any } | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m.role !== "assistant") continue;
		const content = Array.isArray(m.content) ? m.content : [];
		const call = content.find((c: any) => c.type === "toolCall" && c.id === result.toolCallId);
		if (call) return call;
	}
	return null;
}

export interface LoopDecision {
	action: "nudge" | "give-up" | "none";
	nudgeNumber: number;
}

/**
 * What to do about a loop of `count` identical failures, given how many
 * threshold-crossings have already been nudged (`lastNudge`). Nudges fire
 * at each multiple of `threshold` up to `maxNudges`; after that the
 * extension gives up exactly once (then stays quiet for that loop).
 */
export function decideLoopAction(count: number, threshold: number, maxNudges: number, lastNudge: number): LoopDecision {
	const crossing = Math.floor(count / threshold);
	if (crossing < 1) return { action: "none", nudgeNumber: 0 };
	if (crossing > maxNudges) {
		return lastNudge <= maxNudges ? { action: "give-up", nudgeNumber: crossing } : { action: "none", nudgeNumber: crossing };
	}
	if (crossing > lastNudge) return { action: "nudge", nudgeNumber: crossing };
	return { action: "none", nudgeNumber: crossing };
}
