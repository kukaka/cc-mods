// Pure helpers for cc-timing-mod. No `$.` imports — every function here is
// engine-independent and exercised directly by tests/timing.test.ts.
//
// The shape of a TurnRecord is the contract between the hooks module
// (register.tsx) and the rendering code: the session's list of turns is the
// mod's only state, and timing.* is what the renderer reads.

import type { StepPhase, StepPhaseSpan, StepRecord, ToolRecord, TurnRecord } from '../types'

/** How many turns the session keeps. Older ones fall off the end. */
export const MAX_TURNS = 30

/** How many model requests / tool calls one turn keeps. */
export const MAX_STEPS = 40
export const MAX_TOOLS = 40

/**
 * How many phase stretches one model request keeps. Past this the time
 * joins the stretch before it: a request with more phases than that is
 * pathological, and a bounded list is worth more than a perfect split.
 */
export const MAX_PHASE_SPANS = 24

/** A span of wall-clock time, in epoch ms. */
export type Interval = { start: number; end: number }

/** What one turn's time adds up to. */
export type TurnSummary = {
  /** The turn's wall-clock length. */
  totalMs: number
  /** Time the model was thinking / generating. */
  modelMs: number
  /** Time the engine was running tools (parallel calls counted once). */
  toolMs: number
  /** Of that, the time the tools themselves were running. */
  toolExecMs: number
  /**
   * Of that, the time around the tools: what the engine spent on the
   * permission check, the result and the transcript around a call that
   * itself took a fraction of it.
   */
  toolOverheadMs: number
  /** Time the person spent approving a tool call. */
  approvalMs: number
  /** Time other plugins' hooks added (inside the buckets above). */
  hookMs: number
  /** Everything the mod could not attribute — engine overhead, compaction. */
  otherMs: number
  /** How many model requests the turn made. */
  requestCount: number
  /** How many tool calls the turn made. */
  toolCount: number
  /**
   * The time the turn's requests spent waiting for their first byte — the
   * queueing and the input processing before the model said anything.
   */
  ttfbMs: number
  /**
   * The time the turn's requests spent producing: everything after the
   * first byte. The phases below add up to it.
   */
  genMs: number
  /**
   * The model time by phase. The same time as `modelMs`, broken down —
   * `think` + `text` + `tool` + `api` is `genMs`.
   */
  phaseMs: Record<StepPhase, number>
  /** The turn's slowest tools, by total time. */
  topTools: { name: string; ms: number }[]
  /** The plugins whose hooks cost the turn the most. */
  topHooks: { name: string; ms: number }[]
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Keeps the last `max` entries, in their original order. */
export function capList<T>(list: T[], max: number): T[] {
  return list.length <= max ? list : list.slice(list.length - max)
}

/**
 * Merges overlapping / touching intervals into the smallest set of disjoint
 * ones that covers the same time. Intervals with no length are dropped.
 */
export function mergeIntervals(list: Interval[]): Interval[] {
  const sorted = list
    .filter((iv) => iv.end > iv.start)
    .sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Interval[] = []
  for (const iv of sorted) {
    const last = out[out.length - 1]
    if (last && iv.start <= last.end) {
      if (iv.end > last.end) last.end = iv.end
    } else {
      out.push({ start: iv.start, end: iv.end })
    }
  }
  return out
}

/** How much time a set of intervals covers, overlaps counted once. */
export function coveredMs(list: Interval[]): number {
  return mergeIntervals(list).reduce((sum, iv) => sum + (iv.end - iv.start), 0)
}

/**
 * How much of `a` is NOT covered by `b` — the part of a that falls in a gap
 * of b. Used to pull the approval wait out of the tool's own span: the wait
 * happened before the tool ran, but the tool's dispatch clock already
 * covers the minutes before it.
 */
export function subtractMs(a: Interval[], b: Interval[]): number {
  const cover = mergeIntervals(b)
  let total = 0
  for (const iv of mergeIntervals(a)) {
    let cursor = iv.start
    for (const o of cover) {
      if (o.end <= cursor) continue
      if (o.start >= iv.end) break
      if (o.start > cursor) total += o.start - cursor
      cursor = Math.max(cursor, o.end)
      if (cursor >= iv.end) break
    }
    if (cursor < iv.end) total += iv.end - cursor
  }
  return total
}

/**
 * The phase a chunk of the model's response belongs to.
 *
 * The chunk that arrives tells us what the API was doing in the time
 * before it: a thinking chunk means the model was thinking, a text chunk
 * means it was writing, a tool chunk means it was writing a call, and the
 * engine's own chunks (the envelope, the block boundaries, the stop) mean
 * the API was doing its own work.
 */
export function phaseOfChunk(chunk: { kind: string }): StepPhase {
  switch (chunk.kind) {
    case 'thinking':
      return 'think'
    case 'text':
      return 'text'
    case 'tool':
    case 'input':
      return 'tool'
    default:
      return 'api'
  }
}

/**
 * Adds a stretch of time to a request's phases, merging it into the
 * stretch before it when they touch and share a phase.
 *
 * Past `MAX_PHASE_SPANS` the time joins the last stretch: a request with
 * more phases than that is pathological, and a bounded list is worth more
 * than a perfect split.
 */
export function pushSpan(
  spans: StepPhaseSpan[],
  phase: StepPhase,
  from: number,
  to: number,
): void {
  if (to <= from) return
  const last = spans[spans.length - 1]
  if (last && last.phase === phase && last.endMs === from) {
    last.endMs = to
    return
  }
  if (spans.length >= MAX_PHASE_SPANS) {
    if (last) last.endMs = Math.max(last.endMs, to)
    return
  }
  spans.push({ phase, startMs: from, endMs: to })
}

/**
 * A request's phase stretches, as recorded.
 *
 * A request recorded before the phase split existed has none: its time
 * after the first byte is reported as the API's own, which is the most we
 * can say about it.
 */
function spansOf(step: StepRecord): StepPhaseSpan[] {
  const spans = step.phases
  if (spans && spans.length > 0) return spans
  const rest = step.endMs - step.startMs - step.ttfbMs
  if (rest <= 0) return []
  return [{ phase: 'api', startMs: step.startMs + step.ttfbMs, endMs: step.endMs }]
}

/**
 * One model request's own split: the wait for its first byte, and what the
 * model did with the rest.
 */
export type StepSummary = {
  /** The request's wall clock. */
  totalMs: number
  /** The wait for the response's first byte. */
  ttfbMs: number
  /** The time after the first byte — the phases below add up to it. */
  genMs: number
  /** The request's time by phase. */
  phaseMs: Record<StepPhase, number>
}

/** Splits one model request into the wait for its first byte and its phases. */
export function summarizeStep(step: StepRecord): StepSummary {
  const totalMs = Math.max(0, step.endMs - step.startMs)
  const ttfbMs = Math.max(0, Math.min(step.ttfbMs, totalMs))
  const phaseMs: Record<StepPhase, number> = { think: 0, text: 0, tool: 0, api: 0 }
  for (const span of spansOf(step)) {
    phaseMs[span.phase] += Math.max(0, span.endMs - span.startMs)
  }
  const genMs = phaseMs.think + phaseMs.text + phaseMs.tool + phaseMs.api
  return { totalMs, ttfbMs, genMs, phaseMs }
}

/** A wall-clock length, the way a person reads it: `840ms`, `12.3s`, `1m 12s`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const totalSec = Math.round(ms / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return `${min}m ${String(sec).padStart(2, '0')}s`
  return `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`
}

/** A moment of the day, local time: `14:32:05`. */
export function formatClock(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** A token count, shortened: `820`, `12.3k`, `1.2M`. */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

/** A prompt, trimmed to a label that fits in a row. */
export function summarizeLabel(text: string, max = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= max) return flat
  return `${flat.slice(0, max - 1)}…`
}

/** How long a tool call's approval wait was, in ms (0 when nothing was asked). */
export function waitMsOf(tool: ToolRecord): number {
  if (tool.waitStartMs <= 0 || tool.waitEndMs <= tool.waitStartMs) return 0
  return tool.waitEndMs - tool.waitStartMs
}

/**
 * Adds up where a turn's wall-clock time went.
 *
 * The buckets are disjoint and cover the turn:
 *
 *   model     — the model requests, from the request going out to the
 *               response's last chunk, minus the time a tool was already
 *               running (the engine starts a tool while the model is still
 *               streaming).
 *   tools     — the tool calls' dispatches, parallel calls counted once.
 *   approval  — the wait for the person to approve a call, only the part of
 *               it that lies outside a tool's own span (a wait inside the
 *               dispatch is already counted in `tools`).
 *   other     — whatever is left: the engine's own overhead between the
 *               model answering and the tool running, compaction, and the
 *               like.
 *
 * The four add up to the turn's wall clock.
 *
 * `hookMs` is not a bucket of its own: hooks run inside the dispatches
 * above, so it is reported as a breakdown of them.
 */
export function summarize(turn: TurnRecord, now: number): TurnSummary {
  const end = turn.endMs ?? now
  const totalMs = Math.max(0, end - turn.startMs)

  const modelIv = turn.steps.map((s) => ({ start: s.startMs, end: s.endMs }))
  const toolIv = turn.tools.map((t) => ({ start: t.startMs, end: t.endMs }))
  const waitIv = turn.tools
    .filter((t) => t.waitStartMs > 0 && t.waitEndMs > t.waitStartMs)
    .map((t) => ({ start: t.waitStartMs, end: t.waitEndMs }))

  const busyIv = [...modelIv, ...toolIv]
  const busyMs = coveredMs(busyIv)
  const approvalMs = subtractMs(waitIv, busyIv)
  const otherMs = Math.max(0, totalMs - busyMs - approvalMs)

  // The engine starts a tool while the model's response is still streaming,
  // so the two spans can overlap. The overlap is a concrete activity (the
  // tool ran), so the tool keeps it and the model keeps only the time no
  // tool covered — that way the buckets add up to the turn's wall clock.
  const modelMs = subtractMs(modelIv, toolIv)
  const toolMs = coveredMs(toolIv)

  // The model's own time, phase by phase. The same subtraction as above: a
  // phase a tool covered is the tool's, so the phases add up to the model
  // bucket and not to more than it.
  const ttfbMs = subtractMs(
    turn.steps.map((s) => ({ start: s.startMs, end: s.startMs + s.ttfbMs })),
    toolIv,
  )
  const phaseOf = (phase: StepPhase): number =>
    subtractMs(
      turn.steps.flatMap((s) =>
        spansOf(s)
          .filter((p) => p.phase === phase)
          .map((p) => ({ start: p.startMs, end: p.endMs })),
      ),
      toolIv,
    )
  const phaseMs: Record<StepPhase, number> = {
    think: phaseOf('think'),
    text: phaseOf('text'),
    tool: phaseOf('tool'),
    api: phaseOf('api'),
  }
  const genMs = phaseMs.think + phaseMs.text + phaseMs.tool + phaseMs.api

  // The tool's own execution sits at the tail of its dispatch (the engine
  // starts the call, then the tool runs, then the result comes back), so
  // the time left over is the engine's overhead around it.
  const execIv = turn.tools
    .filter((t) => t.execMs !== null)
    .map((t) => ({
      start: t.endMs - (t.execMs ?? 0),
      end: t.endMs,
    }))
  const toolExecMs = coveredMs(execIv)
  const toolOverheadMs = Math.max(0, toolMs - toolExecMs)

  // Slowest tools, by the time each name cost the turn.
  const byTool = new Map<string, number>()
  for (const t of turn.tools) {
    byTool.set(t.tool, (byTool.get(t.tool) ?? 0) + (t.endMs - t.startMs))
  }
  const topTools = [...byTool.entries()]
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)

  const topHooks = Object.entries(turn.hookMsByPlugin)
    .map(([name, ms]) => ({ name, ms }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 5)

  return {
    totalMs,
    modelMs,
    toolMs,
    toolExecMs,
    toolOverheadMs,
    approvalMs,
    hookMs: Object.values(turn.hookMsByPlugin).reduce((a, b) => a + b, 0),
    otherMs,
    requestCount: turn.steps.length,
    toolCount: turn.tools.length,
    ttfbMs,
    genMs,
    phaseMs,
    topTools,
    topHooks,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheWriteTokens: turn.cacheWriteTokens,
  }
}
