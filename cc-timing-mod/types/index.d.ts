// Plugin state contract for cc-timing-mod.
//
// The engine types every `$.state.get` / `$.state.set` in
// hooks/register.tsx against this file, and `claude plugin validate` checks
// that each key the module names is declared here.
//
// The records below are what one turn's profile is made of. They are plain
// JSON (the host stores `$.state` values as JSON), so every field is a
// primitive or a plain array/object — no Date, no Map, no undefined.

/**
 * The phases one model request's wall clock splits into.
 *
 * The wait for the response's first byte is not one of these — it is the
 * request's `ttfbMs` — and the phases cover what came after it.
 */
export type StepPhase =
  /** The model was thinking (extended thinking). */
  | 'think'
  /** The model was writing the text you see. */
  | 'text'
  /** The model was writing a tool call — its name and its arguments. */
  | 'tool'
  /**
   * The API's own work between the model's blocks: the block boundaries, a
   * retry, and the tools the API runs itself (web search and friends).
   */
  | 'api'

/**
 * One stretch of a model request's time, spent in one phase.
 *
 * A request's stretches tile its wall clock after the first byte, so their
 * lengths add up to the request's length.
 */
export type StepPhaseSpan = {
  /** The phase the time was spent in. */
  phase: StepPhase
  /** Wall-clock ms when the stretch began. */
  startMs: number
  /** Wall-clock ms when the stretch ended. */
  endMs: number
}

/**
 * One model request of a turn (`turn.step`).
 *
 * A turn is a sequence of these: the model answers, the engine runs the
 * tools it asked for, the model is asked again, and so on until the turn
 * ends.
 */
export type StepRecord = {
  /** The step's position in the turn, from 0 (`turn.step`'s `e.index`). */
  index: number
  /** The model the request named, as the engine resolved it. */
  model: string
  /** Wall-clock ms when the request went out. */
  startMs: number
  /** Wall-clock ms when the response's last chunk arrived. */
  endMs: number
  /** Ms from the request to its first chunk — the time to first token. */
  ttfbMs: number
  /**
   * The request's time after the first byte, split into phases. The spans
   * tile the rest of the request, so their lengths add up to the request's
   * length minus `ttfbMs`.
   */
  phases: StepPhaseSpan[]
  /** How many tool calls the response asked the engine to run. */
  toolCallCount: number
  /** Ms the API spent on the tools it ran itself (web search and friends). */
  serverToolMs: number
  /** Uncached input tokens the request was answered over. */
  inputTokens: number
  /** Tokens the response generated. */
  outputTokens: number
  /** Input tokens the prompt cache served. */
  cacheReadTokens: number
  /** Input tokens the request wrote to the prompt cache. */
  cacheWriteTokens: number
}

/**
 * One tool call of a turn (`tool.call`).
 */
export type ToolRecord = {
  /** The call's id (`tool_use_id`), the same at every event of the call. */
  toolUseId: string
  /** The tool's name, as the model wrote it. */
  tool: string
  /** Wall-clock ms when the call's dispatch began. */
  startMs: number
  /** Wall-clock ms when the call's dispatch ended. */
  endMs: number
  /**
   * The tool's own execution time in ms — `classic.PostToolUse`'s
   * `duration_ms`, which counts the tool alone (no permission prompt, no
   * hooks). Null when the engine did not report it.
   */
  execMs: number | null
  /** Ms other plugins' hooks added to this call (`next.trace`). */
  hookMs: number
  /**
   * When the approval prompt was raised (epoch ms), 0 when nothing was
   * asked. Together with `waitEndMs` this is the time the person spent
   * deciding — usually the single biggest hidden cost of a long turn.
   */
  waitStartMs: number
  /** When the approved call actually got to run (epoch ms), 0 when nothing was asked. */
  waitEndMs: number
  /** True when the tool reported an error. */
  isError: boolean
}

/**
 * One turn of the conversation — one prompt, one answer, everything the
 * engine did in between.
 */
export type TurnRecord = {
  /** The turn's id, the same one `turn.start` / `turn.complete` carry. */
  turnId: string
  /** The subagent's id when the turn ran in one; absent on the main loop. */
  agentId?: string
  /** The prompt the turn began with, trimmed to a label. */
  label: string
  /** Wall-clock ms when the turn began. */
  startMs: number
  /** Wall-clock ms when the turn ended; null while it still runs. */
  endMs: number | null
  /** Why the turn ended: `answer`, `aborted`, `refusal` or `error`. */
  reason: string | null
  /** The turn's model requests, in order. */
  steps: StepRecord[]
  /** The turn's tool calls, in order. */
  tools: ToolRecord[]
  /** Ms each plugin's hooks added to this turn, by plugin name. */
  hookMsByPlugin: Record<string, number>
  /** Uncached input tokens, summed over the turn's requests. */
  inputTokens: number
  /** Generated tokens, summed over the turn's requests. */
  outputTokens: number
  /** Cache-read input tokens, summed over the turn's requests. */
  cacheReadTokens: number
  /** Cache-write input tokens, summed over the turn's requests. */
  cacheWriteTokens: number
}

declare module 'claude-code' {
  interface PluginState {
    'cc-timing-mod': {
      /** The session's turns, oldest first. */
      turns: TurnRecord[]
    }
  }
}
