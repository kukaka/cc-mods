// Pure helpers for cc-timing-mod. No `$.` imports — every function here is
// engine-independent and exercised directly by tests/timing.test.ts.
//
// The shape of a TurnRecord is the contract between the hooks module
// (register.tsx) and the rendering code: the session's list of turns is the
// mod's only state, and timing.* is what the renderer reads.

import type { ToolRecord, TurnRecord } from '../types'

/** How many turns the session keeps. Older ones fall off the end. */
export const MAX_TURNS = 30

/** How many model requests / tool calls one turn keeps. */
export const MAX_STEPS = 40
export const MAX_TOOLS = 40

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
  /** Mean time to first token over the turn's requests. */
  ttfbAvgMs: number
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

  const ttfbAvgMs =
    turn.steps.length === 0
      ? 0
      : turn.steps.reduce((sum, s) => sum + s.ttfbMs, 0) / turn.steps.length

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
    ttfbAvgMs,
    topTools,
    topHooks,
    inputTokens: turn.inputTokens,
    outputTokens: turn.outputTokens,
    cacheReadTokens: turn.cacheReadTokens,
    cacheWriteTokens: turn.cacheWriteTokens,
  }
}
