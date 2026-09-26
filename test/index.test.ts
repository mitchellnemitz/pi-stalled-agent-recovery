/**
 * Integration tests for the extension wiring (pi/index.ts): the
 * agent_settled handler, retry accounting, loop escalation and give-up,
 * and session-scoped retry/loop accounting.
 *
 * Run: npm test   (from this package directory) — or: node --test test/
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import extension from "../pi/index.ts";

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

function failingCall(name: string, args: any) {
	const call = { name, args, id: `call_${++nextCallId}` };
	return {
		assistantMsg: assistant([call]),
		result: {
			role: "toolResult",
			toolCallId: call.id,
			toolName: call.name,
			content: [{ type: "text", text: "Error: boom" }],
			isError: true,
			timestamp: 0,
		},
	};
}

function makeHarness(sessionId = `s${Math.random().toString(36).slice(2)}`) {
	const handlers: Record<string, any> = {};
	const sent: Array<{ msg: any; opts: any }> = [];
	const notifications: Array<{ text: string; level: string }> = [];

	extension({
		on: (event: string, handler: any) => {
			(handlers[event] ??= []).push(handler);
		},
		sendMessage: (msg: any, opts: any) => {
			sent.push({ msg, opts });
		},
	} as any);

	const ctx = (messages: any[]) => ({
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => messages.map((message) => ({ type: "message", message })),
		},
		ui: { notify: (text: string, level: string) => notifications.push({ text, level }) },
	});

	const settle = async (messages: any[]) => {
		const before = sent.length;
		for (const h of handlers.agent_settled ?? []) await h({}, ctx(messages));
		return sent.slice(before);
	};

	const reset = () => handlers.session_start[0]({}, ctx([]));

	return { sent, notifications, settle, reset, ctx };
}

const THINking_ONLY = { role: "assistant", content: [{ type: "thinking", thinking: "hmm" }], stopReason: "stop" };

describe("empty-response retry wiring", () => {
	it("retries an empty response and resets the budget after a real reply", async () => {
		const h = makeHarness();
		await h.reset();

		const sent1 = await h.settle([THINking_ONLY]);
		assert.equal(sent1.length, 1);
		assert.equal(sent1[0].msg.customType, "stalled-agent-recovery-retry");

		// A real reply ends the occurrence: budget restarts.
		await h.settle([assistant([], "All done.")]);
		const sent2 = await h.settle([THINking_ONLY]);
		assert.equal(sent2.length, 1);
		assert.match(sent2[0].msg.content, /Continuing generation/);
	});

	it("gives an error instead of a follow-up once the retry budget is spent", async () => {
		const h = makeHarness();
		await h.reset();

		for (let i = 0; i < 5; i++) {
			const sent = await h.settle([THINking_ONLY]);
			assert.equal(sent.length, 1, `retry ${i + 1} should dispatch`);
		}
		const notificationsBefore = h.notifications.length;
		const sent = await h.settle([THINking_ONLY]);
		assert.equal(sent.length, 0);
		assert.ok(h.notifications.length > notificationsBefore);
		assert.equal(h.notifications.at(-1).level, "error");
	});

	it("clears the retry budget on an aborted run", async () => {
		const h = makeHarness();
		await h.reset();
		await h.settle([THINking_ONLY]);
		await h.settle([THINking_ONLY]);

		const aborted = { ...THINking_ONLY, stopReason: "aborted" };
		await h.settle([aborted]);

		// Budget was cleared: the next empty response retries from 1 again
		// (proven indirectly: 4 more retries fit before the error).
		for (let i = 0; i < 4; i++) {
			const sent = await h.settle([THINking_ONLY]);
			assert.equal(sent.length, 1);
		}
		const notificationsBefore = h.notifications.length;
		await h.settle([THINking_ONLY]);
		assert.ok(h.notifications.length > notificationsBefore);
	});
});

describe("tool-call loop wiring", () => {
	async function runFails(h: ReturnType<typeof makeHarness>, n: number, call = failingCall("bash", { command: "make test" })) {
		const branch: any[] = [];
		const sends: any[] = [];
		for (let i = 0; i < n; i++) {
			branch.push(call.assistantMsg, call.result);
			sends.push(...(await h.settle(branch)));
		}
		return sends;
	}

	it("sends continuations below the threshold, escalating nudges at crossings, then gives up silently", async () => {
		const h = makeHarness();
		await h.reset();

		const sends = await runFails(h, 20);

		// Fails 1-4: plain continuations. Fail 5: first nudge.
		assert.equal(sends[0].msg.customType, "stalled-agent-recovery-loop");
		assert.match(sends[0].msg.content, /failed 1 time/);
		assert.equal(sends[4].msg.customType, "stalled-agent-recovery-loop");
		assert.match(sends[4].msg.content, /failed 5 times/);
		assert.doesNotMatch(sends[4].msg.content, /Stop retrying/);

		// Fail 10: second nudge. Fail 15: final nudge tells it to stop.
		assert.match(sends[9].msg.content, /failed 10 times/);
		assert.match(sends[14].msg.content, /Stop retrying/);

		// Fails 16-19: silence after the final nudge; fail 20: give-up,
		// also silent (15 sends total).
		assert.equal(sends.length, 15, "no continuations after the final nudge, none on give-up");

		const lastNotification = h.notifications.at(-1);
		assert.equal(lastNotification.level, "error");
		assert.match(lastNotification.text, /no longer intervening/);

		// Beyond give-up: total silence.
		const after = await runFails(h, 2);
		assert.equal(after.length, 0);
	});

	it("does not let a failed sibling from another tool prevent the nudge", async () => {
		const h = makeHarness();
		await h.reset();

		const call = failingCall("bash", { command: "make test" });
		const sib = { name: "grep", args: { pattern: "TODO" }, id: `call_${++nextCallId}` };
		const branch: any[] = [];
		const sends: any[] = [];
		for (let i = 0; i < 5; i++) {
			branch.push(call.assistantMsg, call.result, assistant([sib]), {
				role: "toolResult",
				toolCallId: sib.id,
				toolName: sib.name,
				content: [{ type: "text", text: "Error: sibling failed too" }],
				isError: true,
				timestamp: 0,
			});
			sends.push(...(await h.settle(branch)));
		}
		const nudges = sends.filter((s) => s.msg.content.includes("failed 5 times"));
		assert.equal(nudges.length, 1);
	});

	it("restarts loop state after a real reply", async () => {
		const h = makeHarness();
		await h.reset();

		await runFails(h, 5); // first nudge recorded for this signature
		await h.settle([assistant([], "Moved on.")]);

		// A fresh identical loop nudges again from scratch rather than
		// inheriting the stale crossing count.
		const sends = await runFails(h, 5);
		assert.equal(sends.length, 5);
		assert.match(sends[4].msg.content, /failed 5 times/);
	});

	it("does not reset loop state on a tool-call-only assistant tail", async () => {
		const h = makeHarness();
		await h.reset();

		const call = failingCall("bash", { command: "make test" });
		const branch: any[] = [];
		for (let i = 0; i < 5; i++) {
			branch.push(call.assistantMsg, call.result);
			await h.settle(branch);
		}
		// Mid-loop settle on a tool-call-only assistant message (no text):
		// budgets must survive it.
		await h.settle([...branch, assistant([{ name: "bash", args: { command: "make test" }, id: call.assistantMsg.content[0].id }])]);

		// A 6th identical failure: if loop state had been wiped, this would
		// re-nudge from scratch (crossing 1 > cleared lastNudge). It must
		// instead be a plain continuation at count 6.
		branch.push(call.assistantMsg, call.result);
		const sends = await h.settle(branch);
		assert.equal(sends.length, 1);
		assert.match(sends[0].msg.content, /failed 6 times/);
		assert.doesNotMatch(sends[0].msg.content, /has now failed/);
	});
});
