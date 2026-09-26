/**
 * Unit tests for the stalled-agent-recovery logic (pi/logic.ts).
 *
 * Run: npm test   (from this package directory) — or: node --test test/
 *
 * Covers the two detectors the extension runs at agent_settled:
 * evaluateEmptyResponse (stalled-response detector) and the tool-call
 * loop guard (detectToolLoop + decideLoopAction).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	decideLoopAction,
	detectToolLoop,
	evaluateEmptyResponse,
	isFighterFollowUp,
	loadConfig,
	stableStringify,
	toolCallSignature,
} from "../pi/logic.ts";

// --- message fixtures -------------------------------------------------

let nextCallId = 0;

function assistant(toolCalls: Array<{ name: string; args: any; id?: string }>, text = "") {
	return {
		role: "assistant",
		content: [
			...(text ? [{ type: "text", text }] : []),
			...toolCalls.map((c) => ({
				type: "toolCall",
				id: c.id ?? `call_${++nextCallId}`,
				name: c.name,
				arguments: c.args,
			})),
		],
		stopReason: toolCalls.length > 0 ? "toolUse" : "stop",
		usage: {},
		timestamp: 0,
	};
}

function toolResult(call: { id: string; name: string }, isError: boolean) {
	return {
		role: "toolResult",
		toolCallId: call.id,
		toolName: call.name,
		content: [{ type: "text", text: isError ? "Error: boom" : "ok" }],
		isError,
		timestamp: 0,
	};
}

function failingCall(name: string, args: any) {
	const call = { name, args, id: `call_${++nextCallId}` };
	return { call, assistantMsg: assistant([call]), result: toolResult(call, true) };
}

// --- evaluateEmptyResponse ----------------------------------------------

describe("evaluateEmptyResponse", () => {
	it("flags a thinking-only assistant message", () => {
		const message = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "reasoning..." }],
			stopReason: "stop",
		};
		const result = evaluateEmptyResponse(message);
		assert.equal(result.isEmpty, true);
		assert.match(result.reason, /thinking/i);
	});

	it("does not flag an assistant message that carries a tool call", () => {
		const message = assistant([{ name: "bash", args: { command: "ls" } }]);
		assert.equal(evaluateEmptyResponse(message).isEmpty, false);
	});

	it("flags a bare toolResult tail (halted right after tool execution)", () => {
		const result = evaluateEmptyResponse(toolResult({ id: "x", name: "bash" }, true));
		assert.equal(result.isEmpty, true);
		assert.match(result.reason, /tool execution/i);
	});

	it("does not flag an assistant message with text", () => {
		const message = assistant([], "All done.");
		assert.equal(evaluateEmptyResponse(message).isEmpty, false);
	});

	it("ignores API-error messages", () => {
		const message = { role: "assistant", content: [], stopReason: "error", errorMessage: "boom" };
		assert.equal(evaluateEmptyResponse(message).isEmpty, false);
	});
});

// --- signature helpers -------------------------------------------------

describe("stableStringify", () => {
	it("is order-independent for object keys", () => {
		assert.equal(stableStringify({ b: 1, a: { d: 2, c: 3 } }), stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
	});

	it("distinguishes different argument values", () => {
		assert.notEqual(stableStringify({ command: "ls" }), stableStringify({ command: "pwd" }));
	});
});

describe("toolCallSignature", () => {
	it("is equal for the same tool and arguments regardless of key order", () => {
		assert.equal(
			toolCallSignature({ name: "read", arguments: { path: "/x", offset: 1 } }),
			toolCallSignature({ name: "read", arguments: { offset: 1, path: "/x" } }),
		);
	});

	it("differs when the tool name differs", () => {
		assert.notEqual(
			toolCallSignature({ name: "read", arguments: { path: "/x" } }),
			toolCallSignature({ name: "write", arguments: { path: "/x" } }),
		);
	});
});

// --- detectToolLoop -----------------------------------------------------

describe("detectToolLoop", () => {
	it("returns null when the tail is an assistant message", () => {
		const call = failingCall("bash", { command: "make test" });
		const messages = [call.assistantMsg, call.result, assistant([], "Giving up.")];
		assert.equal(detectToolLoop(messages), null);
	});

	it("returns null when the tail tool result is not an error", () => {
		const call = failingCall("bash", { command: "make test" });
		const messages = [call.assistantMsg, toolResult(call.call, false)];
		assert.equal(detectToolLoop(messages), null);
	});

	it("counts one failing call with no repetition", () => {
		const call = failingCall("bash", { command: "make test" });
		const messages = [call.assistantMsg, call.result];
		const loop = detectToolLoop(messages);
		assert.ok(loop);
		assert.equal(loop.count, 1);
		assert.equal(loop.toolName, "bash");
	});

	it("counts consecutive identical failing calls", () => {
		const a = failingCall("bash", { command: "make test" });
		const b = failingCall("bash", { command: "make test" });
		const messages = [a.assistantMsg, a.result, b.assistantMsg, b.result];
		const loop = detectToolLoop(messages);
		assert.ok(loop);
		assert.equal(loop.count, 2);
		assert.equal(loop.toolName, "bash");
	});

	it("does not count a changed call as part of the loop", () => {
		const a = failingCall("bash", { command: "make test" });
		const b = failingCall("bash", { command: "make test -j4" });
		const messages = [a.assistantMsg, a.result, b.assistantMsg, b.result];
		const loop = detectToolLoop(messages);
		assert.ok(loop);
		assert.equal(loop.count, 1);
	});

	it("does not let successful results from other tools break the run", () => {
		const read = { name: "read", args: { path: "/x" }, id: `call_${++nextCallId}` };
		const a = failingCall("bash", { command: "make test" });
		const b = failingCall("bash", { command: "make test" });
		const messages = [
			a.assistantMsg,
			a.result,
			assistant([read]),
			toolResult(read, false),
			b.assistantMsg,
			b.result,
		];
		const loop = detectToolLoop(messages);
		assert.ok(loop);
		assert.equal(loop.count, 2);
	});

	it("counts identical failing calls across a multi-call assistant message", () => {
		const a = failingCall("bash", { command: "make test" });
		const other = { name: "grep", args: { pattern: "x" }, id: `call_${++nextCallId}` };
		const b = failingCall("bash", { command: "make test" });
		const messages = [
			a.assistantMsg,
			a.result,
			assistant([other, { name: b.call.name, args: b.call.args, id: b.call.id }]),
			toolResult(other, false),
			b.result,
		];
		const loop = detectToolLoop(messages);
		assert.ok(loop);
		assert.equal(loop.count, 2);
	});
});

// --- decideLoopAction ----------------------------------------------------

describe("decideLoopAction", () => {
	const threshold = 2;
	const maxNudges = 3;

	it("stays quiet before the first threshold crossing", () => {
		assert.deepEqual(decideLoopAction(1, threshold, maxNudges, 0), { action: "none", nudgeNumber: 0 });
	});

	it("nudges at the first crossing", () => {
		assert.deepEqual(decideLoopAction(2, threshold, maxNudges, 0), { action: "nudge", nudgeNumber: 1 });
	});

	it("does not re-nudge within the same crossing window", () => {
		assert.deepEqual(decideLoopAction(3, threshold, maxNudges, 1), { action: "none", nudgeNumber: 1 });
	});

	it("re-nudges at the next crossing", () => {
		assert.deepEqual(decideLoopAction(4, threshold, maxNudges, 1), { action: "nudge", nudgeNumber: 2 });
	});

	it("gives up after the max nudge, once", () => {
		assert.deepEqual(decideLoopAction(8, threshold, maxNudges, 3), { action: "give-up", nudgeNumber: 4 });
		assert.deepEqual(decideLoopAction(10, threshold, maxNudges, 4), { action: "none", nudgeNumber: 5 });
	});
});

// --- sibling / follow-up walk semantics ---------------------------------

describe("detectToolLoop walk semantics", () => {
	it("does not let a failed sibling from another tool break the run", () => {
		const a = failingCall("bash", { command: "make test" });
		const sib = { name: "grep", args: { pattern: "TODO" }, id: `call_${++nextCallId}` };
		const b = failingCall("bash", { command: "make test" });
		const messages = [
			a.assistantMsg,
			a.result,
			assistant([sib, { name: b.call.name, args: b.call.args, id: b.call.id }]),
			toolResult(sib, true),
			b.result,
		];
		const loop = detectToolLoop(messages);
		assert.ok(loop);
		assert.equal(loop.count, 2);
	});

	it("skips extension-injected follow-up messages between failures", () => {
		const a = failingCall("bash", { command: "make test" });
		const b = failingCall("bash", { command: "make test" });
		const nudge = { role: "user", customType: "stalled-agent-recovery-loop", content: "stop repeating" };
		const messages = [a.assistantMsg, a.result, nudge, b.assistantMsg, b.result];
		const loop = detectToolLoop(messages);
		assert.ok(loop);
		assert.equal(loop.count, 2);
	});

	it("stops at a genuine user message", () => {
		const a = failingCall("bash", { command: "make test" });
		const b = failingCall("bash", { command: "make test" });
		const messages = [a.assistantMsg, a.result, { role: "user", content: "hey, look at this" }, b.assistantMsg, b.result];
		const loop = detectToolLoop(messages);
		assert.ok(loop);
		assert.equal(loop.count, 1);
	});
});

describe("isFighterFollowUp", () => {
	it("recognizes its own follow-up messages", () => {
		assert.equal(isFighterFollowUp({ role: "user", customType: "stalled-agent-recovery-loop" }), true);
		assert.equal(isFighterFollowUp({ role: "user", customType: "stalled-agent-recovery-retry" }), true);
	});

	it("ignores genuine user messages and other extensions' messages", () => {
		assert.equal(isFighterFollowUp({ role: "user", content: "hello" }), false);
		assert.equal(isFighterFollowUp({ role: "user", customType: "other-extension" }), false);
		assert.equal(isFighterFollowUp({ role: "toolResult", customType: "stalled-agent-recovery-loop" }), false);
	});
});

// --- config loading -------------------------------------------------------

describe("loadConfig", () => {
	const dir = mkdtempSync(join(tmpdir(), "stalled-agent-recovery-test-"));

	it("returns defaults when the file is missing", () => {
		assert.deepEqual(loadConfig(join(dir, "missing.json")), { maxRetries: 5, loopThreshold: 5, maxLoopNudges: 3 });
	});

	it("returns defaults on malformed JSON instead of throwing", () => {
		const path = join(dir, "malformed.json");
		writeFileSync(path, "{not json", "utf8");
		assert.deepEqual(loadConfig(path), { maxRetries: 5, loopThreshold: 5, maxLoopNudges: 3 });
	});

	it("clamps invalid values from the file", () => {
		const path = join(dir, "invalid.json");
		writeFileSync(path, JSON.stringify({ maxRetries: 0, loopThreshold: 0, maxLoopNudges: -1 }), "utf8");
		assert.deepEqual(loadConfig(path), { maxRetries: 0, loopThreshold: 5, maxLoopNudges: 3 });
		rmSync(dir, { recursive: true, force: true });
	});
});
