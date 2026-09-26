# pi-stalled-agent-recovery

A [Pi](https://github.com/earendil-works/pi) extension that fights two
agent-stall modes: responses that never produce output, and tool-call
loops where the model repeats an identical failing call.

## What it does

**Empty / thinking-only retry**: when a run settles with an
assistant message that has no output text and no tool calls — including
thinking-only responses — the extension dispatches a follow-up to continue
generation, up to `maxRetries` (default 5) per occurrence. The budget is
per occurrence: a successful reply, an aborted run, or a session restart
resets it. Manually aborted runs are never retried. A successful tool
result the model never followed up on is also retried this way.

**Tool-call loop guard** (new): when a run settles on a *failed* tool
result, the loop guard owns the turn outright (the generic retry never
touches failing tool tails, so the two budgets can't fight). It walks the
branch tail and counts identical failing calls, matching by tool name and
arguments (key-order-independent). The count is broken only by a success
of the same call, a changed call (same tool, different arguments —
legitimate iteration), or a genuine user message; results from other
tools — successful or failed — do not interrupt it, and the extension's
own injected follow-ups are invisible to the count.

At each multiple of `loopThreshold` (default 5) the extension injects a
follow-up telling the model to stop repeating the call unchanged; the
instruction escalates to "stop and report" at `maxLoopNudges` (default 3).
After the final nudge the extension goes quiet — at the next crossing it
surfaces an error notification and stops intervening on that loop
entirely. Between crossings, the model gets a plain change-approach
continuation. Loop state resets when a real reply settles or the session
restarts, so a later identical loop starts fresh.

## Install

```
pi install git:github.com/mitchellnemitz/pi-stalled-agent-recovery
```

or from a local checkout:

```
pi install /path/to/pi-stalled-agent-recovery
```

Reload Pi (`/reload`) or restart it to load the extension.

## Configuration

Settings persist in
`~/.pi/agent/stalled-agent-recovery.json`; edit it and reload Pi:

```json
{
  "maxRetries": 5,
  "loopThreshold": 5,
  "maxLoopNudges": 3
}
```

- `maxRetries`: auto-retries per empty/thinking-only occurrence (0 disables).
- `loopThreshold`: identical failing calls before the first nudge (>= 1).
- `maxLoopNudges`: nudges per loop before the extension gives up (>= 1).

## Tests

From this package directory:

```
npm test   # node --test test/
```

Covers the pure detectors (logic.test.ts) and the extension wiring —
retry accounting, loop escalation and give-up, state resets, and the extension wiring (index.test.ts).

## Typecheck

```
npm run typecheck
```
