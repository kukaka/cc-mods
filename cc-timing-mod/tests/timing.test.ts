import { expect, test } from 'claude-code/testing'

import type { StepPhaseSpan, StepRecord, ToolRecord, TurnRecord } from '../types'
import {
  MAX_PHASE_SPANS,
  capList,
  coveredMs,
  formatDuration,
  formatTokens,
  mergeIntervals,
  phaseOfChunk,
  pushSpan,
  subtractMs,
  summarize,
  summarizeLabel,
  summarizeStep,
  waitMsOf,
} from '../hooks/timing'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const step = (over: Partial<StepRecord> = {}): StepRecord => ({
  index: 0,
  model: 'test-model',
  startMs: 1000,
  endMs: 2000,
  ttfbMs: 200,
  phases: [],
  toolCallCount: 0,
  serverToolMs: 0,
  inputTokens: 100,
  outputTokens: 50,
  cacheReadTokens: 1000,
  cacheWriteTokens: 0,
  ...over,
})

const tool = (over: Partial<ToolRecord> = {}): ToolRecord => ({
  toolUseId: 't1',
  tool: 'Bash',
  startMs: 1000,
  endMs: 2000,
  execMs: 900,
  hookMs: 0,
  waitStartMs: 0,
  waitEndMs: 0,
  isError: false,
  ...over,
})

const turn = (over: Partial<TurnRecord> = {}): TurnRecord => ({
  turnId: 'turn-1',
  label: 'do a thing',
  startMs: 1000,
  endMs: 10000,
  reason: 'answer',
  steps: [],
  tools: [],
  hookMsByPlugin: {},
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  ...over,
})

// ---------------------------------------------------------------------------
// Interval maths
// ---------------------------------------------------------------------------

test('capList keeps the last N entries in order', () => {
  expect(capList([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5])
  expect(capList([1, 2], 5)).toEqual([1, 2])
  expect(capList([], 5)).toEqual([])
})

test('mergeIntervals merges overlapping and touching spans', () => {
  expect(
    mergeIntervals([
      { start: 0, end: 100 },
      { start: 50, end: 150 },
    ]),
  ).toEqual([{ start: 0, end: 150 }])

  // Touching spans (end === start) merge too.
  expect(
    mergeIntervals([
      { start: 0, end: 100 },
      { start: 100, end: 200 },
    ]),
  ).toEqual([{ start: 0, end: 200 }])

  // Disjoint spans stay apart.
  expect(
    mergeIntervals([
      { start: 0, end: 100 },
      { start: 200, end: 300 },
    ]),
  ).toEqual([
    { start: 0, end: 100 },
    { start: 200, end: 300 },
  ])
})

test('mergeIntervals drops empty spans', () => {
  expect(mergeIntervals([{ start: 100, end: 100 }])).toEqual([])
  expect(mergeIntervals([{ start: 200, end: 100 }])).toEqual([])
})

test('coveredMs counts an overlap once', () => {
  expect(
    coveredMs([
      { start: 0, end: 100 },
      { start: 50, end: 150 },
    ]),
  ).toBe(150)
})

test('subtractMs returns the part of a that b does not cover', () => {
  // 0..40 and 60..100 are left over.
  expect(subtractMs([{ start: 0, end: 100 }], [{ start: 40, end: 60 }])).toBe(80)
  // Fully covered → nothing left.
  expect(subtractMs([{ start: 0, end: 100 }], [{ start: 0, end: 100 }])).toBe(0)
  // Not covered at all → all of it.
  expect(subtractMs([{ start: 0, end: 100 }], [{ start: 200, end: 300 }])).toBe(100)
})

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

test('formatDuration reads like a person would say it', () => {
  expect(formatDuration(840)).toBe('840ms')
  expect(formatDuration(12_300)).toBe('12.3s')
  expect(formatDuration(72_000)).toBe('1m 12s')
  expect(formatDuration(3_723_000)).toBe('1h 02m')
  expect(formatDuration(-1)).toBe('—')
})

test('formatTokens shortens big counts', () => {
  expect(formatTokens(0)).toBe('0')
  expect(formatTokens(820)).toBe('820')
  expect(formatTokens(12_300)).toBe('12.3k')
  expect(formatTokens(1_200_000)).toBe('1.2M')
})

test('summarizeLabel flattens and trims a prompt', () => {
  expect(summarizeLabel('hello   world')).toBe('hello world')
  expect(summarizeLabel('a'.repeat(80)).length).toBe(48)
  expect(summarizeLabel('short', 10)).toBe('short')
})

test('waitMsOf is zero when nothing was asked', () => {
  expect(waitMsOf(tool())).toBe(0)
  expect(waitMsOf(tool({ waitStartMs: 100, waitEndMs: 400 }))).toBe(300)
  // A wait that ends before it starts is not a wait.
  expect(waitMsOf(tool({ waitStartMs: 400, waitEndMs: 100 }))).toBe(0)
})

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test('summarize splits a turn into model, tools, approval and other', () => {
  const t = turn({
    startMs: 0,
    endMs: 10_000,
    steps: [step({ startMs: 0, endMs: 4000 })],
    tools: [tool({ startMs: 4000, endMs: 6000 })],
  })
  const s = summarize(t, 10_000)
  expect(s.totalMs).toBe(10_000)
  expect(s.modelMs).toBe(4000)
  expect(s.toolMs).toBe(2000)
  expect(s.approvalMs).toBe(0)
  expect(s.otherMs).toBe(4000)
  expect(s.requestCount).toBe(1)
  expect(s.toolCount).toBe(1)
})

test('summarize counts parallel tool calls once', () => {
  const t = turn({
    startMs: 0,
    endMs: 6000,
    tools: [
      tool({ toolUseId: 'a', startMs: 1000, endMs: 3000 }),
      tool({ toolUseId: 'b', startMs: 1000, endMs: 3000 }),
    ],
  })
  expect(summarize(t, 6000).toolMs).toBe(2000)
})

test('summarize gives a tool the time it overlaps the model', () => {
  // The engine starts the tool while the model is still streaming: the
  // overlap is the tool's, and the buckets still add up to the wall clock.
  const t = turn({
    startMs: 0,
    endMs: 10_000,
    steps: [step({ startMs: 0, endMs: 5000 })],
    tools: [tool({ startMs: 4000, endMs: 6000 })],
  })
  const s = summarize(t, 10_000)
  expect(s.modelMs).toBe(4000)
  expect(s.toolMs).toBe(2000)
  expect(s.otherMs).toBe(4000)
  expect(s.modelMs + s.toolMs + s.approvalMs + s.otherMs).toBe(s.totalMs)
})

test('summarize keeps an approval wait outside the tool it belongs to', () => {
  // The person took 5s to approve; the tool itself ran for 1s. The wait
  // sits before the call's dispatch, so it is its own bucket.
  const t = turn({
    startMs: 0,
    endMs: 10_000,
    tools: [
      tool({
        startMs: 6000,
        endMs: 7000,
        waitStartMs: 1000,
        waitEndMs: 6000,
      }),
    ],
  })
  const s = summarize(t, 10_000)
  expect(s.approvalMs).toBe(5000)
  expect(s.toolMs).toBe(1000)
  // 10s of wall clock, 5s of it spent waiting for the person, 1s of it
  // running the tool — the remaining 4s is the engine's own overhead.
  expect(s.otherMs).toBe(4000)
})

test('summarize does not double-count a wait inside the tool span', () => {
  const t = turn({
    startMs: 0,
    endMs: 10_000,
    tools: [
      tool({
        startMs: 1000,
        endMs: 6000,
        waitStartMs: 2000,
        waitEndMs: 3000,
      }),
    ],
  })
  const s = summarize(t, 10_000)
  // The wait lies inside the tool's own dispatch, so it is already in
  // toolMs — it must not be counted a second time.
  expect(s.approvalMs).toBe(0)
  expect(s.toolMs).toBe(5000)
  expect(s.otherMs).toBe(5000)
})

test('summarize reports a running turn against the clock it is given', () => {
  const t = turn({ startMs: 0, endMs: null })
  const s = summarize(t, 2500)
  expect(s.totalMs).toBe(2500)
  expect(s.otherMs).toBe(2500)
})

test('summarize ranks the turn\'s slowest tools and costliest hooks', () => {
  const t = turn({
    startMs: 0,
    endMs: 10_000,
    tools: [
      tool({ toolUseId: 'a', tool: 'Bash', startMs: 0, endMs: 3000 }),
      tool({ toolUseId: 'b', tool: 'Read', startMs: 3000, endMs: 6000 }),
      tool({ toolUseId: 'c', tool: 'Bash', startMs: 6000, endMs: 7000 }),
    ],
    hookMsByPlugin: { 'cc-a-mod': 500, 'cc-b-mod': 20 },
  })
  const s = summarize(t, 10_000)
  expect(s.topTools[0]).toEqual({ name: 'Bash', ms: 4000 })
  expect(s.topTools[1]).toEqual({ name: 'Read', ms: 3000 })
  expect(s.topHooks[0]).toEqual({ name: 'cc-a-mod', ms: 500 })
  expect(s.hookMs).toBe(520)
})

test('summarize adds up the time to first token over the turn', () => {
  const t = turn({
    startMs: 0,
    endMs: 10_000,
    steps: [
      step({ startMs: 0, endMs: 1000, ttfbMs: 100 }),
      step({ startMs: 1000, endMs: 3000, ttfbMs: 500 }),
    ],
  })
  expect(summarize(t, 10_000).ttfbMs).toBe(600)
})

test('summarize splits a tool call into its execution and the overhead around it', () => {
  // The dispatch took 2.2s; the tool itself ran for 270ms.
  const t = turn({
    startMs: 0,
    endMs: 10_000,
    tools: [tool({ startMs: 1000, endMs: 3200, execMs: 270 })],
  })
  const s = summarize(t, 10_000)
  expect(s.toolMs).toBe(2200)
  expect(s.toolExecMs).toBe(270)
  expect(s.toolOverheadMs).toBe(1930)
})

// ---------------------------------------------------------------------------
// The model's phases
// ---------------------------------------------------------------------------

test('phaseOfChunk reads the chunk kind as the phase it belongs to', () => {
  expect(phaseOfChunk({ kind: 'thinking' })).toBe('think')
  expect(phaseOfChunk({ kind: 'text' })).toBe('text')
  expect(phaseOfChunk({ kind: 'tool' })).toBe('tool')
  // The arguments of a call are the model writing the call.
  expect(phaseOfChunk({ kind: 'input' })).toBe('tool')
  // The engine's own chunks are the API's own work.
  expect(phaseOfChunk({ kind: 'engine' })).toBe('api')
  expect(phaseOfChunk({ kind: 'stop' })).toBe('api')
})

test('pushSpan merges the stretches that touch and share a phase', () => {
  const spans: StepPhaseSpan[] = []
  pushSpan(spans, 'think', 100, 200)
  pushSpan(spans, 'think', 200, 300)
  expect(spans).toEqual([{ phase: 'think', startMs: 100, endMs: 300 }])

  // A different phase starts a stretch of its own.
  pushSpan(spans, 'text', 300, 400)
  expect(spans).toHaveLength(2)

  // A stretch of no time is no stretch.
  pushSpan(spans, 'text', 400, 400)
  expect(spans).toHaveLength(2)
})

test('pushSpan bounds how many stretches one request keeps', () => {
  const spans: StepPhaseSpan[] = []
  for (let i = 0; i < MAX_PHASE_SPANS + 10; i++) {
    pushSpan(spans, i % 2 === 0 ? 'think' : 'text', i * 10, i * 10 + 5)
  }
  expect(spans.length).toBe(MAX_PHASE_SPANS)
})

test('summarizeStep splits a request into its first byte and its phases', () => {
  const s = summarizeStep(
    step({
      startMs: 1000,
      endMs: 5000,
      ttfbMs: 200,
      phases: [
        { phase: 'think', startMs: 1200, endMs: 2200 },
        { phase: 'text', startMs: 2200, endMs: 4200 },
        { phase: 'api', startMs: 4200, endMs: 5000 },
      ],
    }),
  )
  expect(s.totalMs).toBe(4000)
  expect(s.ttfbMs).toBe(200)
  expect(s.phaseMs.think).toBe(1000)
  expect(s.phaseMs.text).toBe(2000)
  expect(s.phaseMs.api).toBe(800)
  expect(s.genMs).toBe(3800)
})

test('summarize breaks the model time into phases that add up to it', () => {
  const t = turn({
    startMs: 0,
    endMs: 10_000,
    steps: [
      step({
        startMs: 0,
        endMs: 4000,
        ttfbMs: 200,
        phases: [
          { phase: 'think', startMs: 200, endMs: 1200 },
          { phase: 'text', startMs: 1200, endMs: 3200 },
          { phase: 'api', startMs: 3200, endMs: 4000 },
        ],
      }),
    ],
  })
  const s = summarize(t, 10_000)
  expect(s.modelMs).toBe(4000)
  expect(s.ttfbMs).toBe(200)
  expect(s.phaseMs.think).toBe(1000)
  expect(s.phaseMs.text).toBe(2000)
  expect(s.phaseMs.api).toBe(800)
  expect(s.genMs).toBe(3800)
  // The wait for the first byte and the phases after it are the model
  // bucket, split — neither more nor less.
  expect(s.ttfbMs + s.genMs).toBe(s.modelMs)
})

test('a tool that overlapped a phase takes that time from it', () => {
  // The engine starts the tool while the model is still writing.
  const t = turn({
    startMs: 0,
    endMs: 10_000,
    steps: [
      step({
        startMs: 0,
        endMs: 5000,
        ttfbMs: 200,
        phases: [
          { phase: 'think', startMs: 200, endMs: 1200 },
          { phase: 'text', startMs: 1200, endMs: 4800 },
          { phase: 'api', startMs: 4800, endMs: 5000 },
        ],
      }),
    ],
    tools: [tool({ startMs: 3000, endMs: 4000 })],
  })
  const s = summarize(t, 10_000)
  expect(s.modelMs).toBe(4000)
  expect(s.phaseMs.text).toBe(2600)
  expect(s.phaseMs.think).toBe(1000)
  expect(s.ttfbMs + s.genMs).toBe(s.modelMs)
})

test('a request recorded before the phase split is the API\'s own time', () => {
  const s = summarizeStep(step({ startMs: 0, endMs: 1000, ttfbMs: 100, phases: [] }))
  expect(s.ttfbMs).toBe(100)
  expect(s.phaseMs.api).toBe(900)
  expect(s.genMs).toBe(900)
})
