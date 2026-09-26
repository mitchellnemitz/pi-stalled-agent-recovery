import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	decideLoopAction,
	detectToolLoop,
	evaluateEmptyResponse,
	isFighterFollowUp,
	loadConfig,
	NOTIFY_PREFIX,
	type StalledAgentRecoveryConfig,
} from "./logic.ts";

const LOOP_NUDGE_MESSAGE = (count: number, toolName: string, final: boolean) =>
	final
		? `The same ${toolName} tool call has now failed ${count} times with identical arguments. Stop retrying it. Report the failure to the user in plain text and end your turn.`
		: `The same ${toolName} tool call has now failed ${count} times with identical arguments. Do not repeat it unchanged. Either change the approach, or report the failure to the user and stop.`;

const LOOP_CONTINUE_MESSAGE = (count: number, toolName: string) =>
	`That ${toolName} tool call has failed ${count} times now. Do not repeat it unchanged. Either change the approach, or report the failure to the user and stop.`;

// Session-scoped state. Keyed by session id; cleared on session_start.
const retryCountsBySession = new Map<string, number>();
const loopNudgesBySession = new Map<string, Map<string, number>>();

export default function (pi: ExtensionAPI) {
	const sessionKey = (ctx: any) => ctx?.sessionManager?.getSessionId?.() ?? "default";

	pi.on("session_start", (_event, ctx) => {
		const sessionId = sessionKey(ctx);
		retryCountsBySession.delete(sessionId);
		loopNudgesBySession.delete(sessionId);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		const sessionId = sessionKey(ctx);
		const config = loadConfig();

		const entries = ctx.sessionManager.getBranch();
		const messages = entries.filter((entry: any) => entry.type === "message").map((entry: any) => entry.message);
		if (messages.length === 0) return;

		const lastMessage = messages[messages.length - 1];

		if (lastMessage.role === "assistant" && lastMessage.stopReason === "aborted") {
			retryCountsBySession.delete(sessionId);
			loopNudgesBySession.delete(sessionId);
			return;
		}

		// A settled assistant message with output text ends any active retry
		// occurrence and any active loop: both budgets restart fresh. A
		// tool-call-only assistant tail is a mid-loop settle — budgets stay.
		if (lastMessage.role === "assistant") {
			const { isEmpty } = evaluateEmptyResponse(lastMessage);
			if (isEmpty) {
				// empty/thinking-only: fall through to the retry path below
			} else {
				const hasText = Array.isArray(lastMessage.content)
					&& lastMessage.content.some((c: any) => c.type === "text" && (c.text ?? "").trim().length > 0);
				if (hasText) {
					retryCountsBySession.delete(sessionId);
					loopNudgesBySession.delete(sessionId);
				}
				return;
			}
		}

		// The loop guard owns failing tool-result tails outright, so the
		// generic retry budget and the loop escalations can never fight over
		// the same turn.
		if (lastMessage.role === "toolResult" && lastMessage.isError) {
			handleFailingTail(pi, sessionId, messages, config, ctx);
			return;
		}

		// Remaining shapes: empty/thinking-only assistant messages, and
		// successful tool results the model never followed up on.
		const { isEmpty, reason } = evaluateEmptyResponse(lastMessage);
		if (!isEmpty) return;

		if (config.maxRetries <= 0) return;

		const retryCount = retryCountsBySession.get(sessionId) ?? 0;
		if (retryCount >= config.maxRetries) {
			ctx.ui.notify(`${NOTIFY_PREFIX} Failed to get response after ${config.maxRetries} attempt(s).`, "error");
			retryCountsBySession.delete(sessionId);
			return;
		}

		retryCountsBySession.set(sessionId, retryCount + 1);
		ctx.ui.notify(`${NOTIFY_PREFIX} ${reason}. Retrying agent run (${retryCount + 1}/${config.maxRetries})...`, "warning");
		pi.sendMessage(
			{
				customType: "stalled-agent-recovery-retry",
				content: "Continuing generation of truncated response...",
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	});
}

/**
 * Intervene on a failing tool-result tail. The tail either matches a known
 * loop shape (escalating nudges, then silence) or falls back to the generic
 * continuation. Injected follow-up messages are invisible to the detector,
 * so escalations fire across turns.
 */
function handleFailingTail(
	pi: ExtensionAPI,
	sessionId: string,
	messages: any[],
	config: StalledAgentRecoveryConfig,
	ctx: any,
): void {
	const loop = detectToolLoop(messages);
	if (!loop) return;

	const perSession = loopNudgesBySession.get(sessionId) ?? new Map<string, number>();
	const lastNudge = perSession.get(loop.signature) ?? 0;
	const givenUp = lastNudge > config.maxLoopNudges;
	const decision = decideLoopAction(loop.count, config.loopThreshold, config.maxLoopNudges, lastNudge);

	if (decision.action === "nudge") {
		perSession.set(loop.signature, decision.nudgeNumber);
		loopNudgesBySession.set(sessionId, perSession);
		const final = decision.nudgeNumber === config.maxLoopNudges;
		pi.sendMessage(
			{
				customType: "stalled-agent-recovery-loop",
				content: LOOP_NUDGE_MESSAGE(loop.count, loop.toolName, final),
				display: false,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
		return;
	}

	if (decision.action === "give-up") {
		perSession.set(loop.signature, decision.nudgeNumber);
		loopNudgesBySession.set(sessionId, perSession);
		ctx.ui.notify(
			`${NOTIFY_PREFIX} ${loop.toolName} call still failing after ${config.maxLoopNudges} nudges — no longer intervening on this loop.`,
			"error",
		);
		return;
	}

	// decision.action === "none": below the first threshold, between
	// crossings of an already-nudged loop, or after the final nudge. Keep
	// the model moving — unless this loop was given up on, or the final
	// "stop and report" nudge already fired (stay quiet until give-up).
	if (givenUp) return;
	if (lastNudge >= config.maxLoopNudges) return;

	pi.sendMessage(
		{
			customType: "stalled-agent-recovery-loop",
			content: LOOP_CONTINUE_MESSAGE(loop.count, loop.toolName),
			display: false,
		},
		{ triggerTurn: true, deliverAs: "followUp" },
	);
}
