// Tests for hooks/register.tsx — the glue between the engine's events and
// the timeline.
//
// The arithmetic lives in hooks/timing.ts and is exercised by
// timing.test.ts. Here we cover the wiring the engine sees: the command,
// the band's tree, the pane's tree.
//
// Test-kit pattern (per the engine docs):
//   * `$.<noun>.<method>(...)` raises the event over every plugin — the kit
//     answers it with the test's own `on` handler, so the test registers
//     one for each event it raises.
//   * Every `on(...)` has to be registered before the test's first `$.`
//     call, which is what loads the plugins.
//   * The kit strips `onPress` from rendered trees, so we assert on props
//     and text, not on pressing.
//
// Run with `claude plugin test ./cc-timing-mod`.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const PANE_ID = 'cc-timing-mod-pane'
const COMMAND_NAME = 'timing'

const SCROLL = { offset: 0, bodyRows: 20 } as const

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 80,
  scroll: SCROLL,
  view: {},
} as const

const PANE_PROPS = {
  title: 'Turn timing',
  isFocused: false,
  bodyColumns: 80,
  placement: 'dock',
  scroll: SCROLL,
  view: {},
} as const

/** A command run the way the engine stamps one. */
const COMMAND_RUN = {
  command: COMMAND_NAME,
  args: '',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
}

// ---------------------------------------------------------------------------
// Element-tree helpers — the shapes the tests assert against.
// ---------------------------------------------------------------------------

type Element = {
  type: string
  props?: Record<string, unknown>
  children?: unknown[]
}

function asElement(v: unknown): Element {
  if (!v || typeof v !== 'object' || typeof (v as { type?: unknown }).type !== 'string') {
    throw new Error(
      `expected an element tree, got: ${typeof v} (${JSON.stringify(v)})`,
    )
  }
  return v as Element
}

function asText(v: unknown): string {
  const e = asElement(v)
  const first = e.children?.[0]
  if (typeof first !== 'string') {
    throw new Error(`expected Text element, children=[string]; got ${JSON.stringify(e)}`)
  }
  return first
}

function findAll(tree: Element | null, type: string, into: Element[] = []): Element[] {
  if (!tree) return into
  if (tree.type === type) into.push(tree)
  for (const c of tree.children ?? []) {
    if (c && typeof c === 'object' && typeof (c as { type?: unknown }).type === 'string') {
      findAll(c as Element, type, into)
    }
  }
  return into
}

function textsOf(tree: Element): string[] {
  return findAll(tree, 'Text')
    .map((t) => t.children?.[0])
    .filter((c): c is string => typeof c === 'string')
}

/** The engine's own drawing — what a `ui.render` chain falls back to. */
const ENGINE_TREE = { type: 'engine', ref: 0 } as never

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

/**
 * The kit needs something beneath the plugin to answer `session.start` and
 * `ui.render`; without them our own hooks are skipped. `mock.clock` answers
 * the ticker our session.start starts.
 *
 * `command.register` is left to the test: our session.start calls it, and a
 * test that wants to see what was registered installs its own handler —
 * which is also the handler the kit needs to answer the call.
 */
async function bootstrap($: Engine, on: On): Promise<void> {
  mock.clock(on)
  on('session.start', () => ({ cwd: '/work' }))
  // The chain beneath us: the engine's own drawing. Answering it here
  // (rather than calling `next`) keeps the bottom of the chain from
  // refusing, and lets the band compose with "someone else's" tree.
  on('ui.render', () => ENGINE_TREE)
  // The turn events a test raises, answered beneath us.
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'done' }))
  on('tool.call', () => ({ result: 'ok' }) as never)
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

/** Raises a turn, so the profiler has something to measure. */
async function runTurn($: Engine, turnId = 'turn-1'): Promise<void> {
  await $.turn.start({ text: 'find the bug', turnId })
  await $.turn.complete({
    answer: 'done',
    durationMs: 1000,
    isAborted: false,
    turnId,
    reason: 'answer',
  })
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

describe('the command', () => {
  test('session.start registers /timing', async ($, on) => {
    const registered: Array<{ name: string; description: string }> = []
    on('command.register', ($, e) => {
      registered.push(e as { name: string; description: string })
      return { value: { command: e.name } }
    })
    await bootstrap($, on)

    expect(registered.length).toBe(1)
    expect(registered[0]?.name).toBe(COMMAND_NAME)
  })

  test('/timing opens the Pane on the first call and closes it on the second', async ($, on) => {
    const opens: Array<{ id: string; title?: string }> = []
    const closes: Array<{ id: string }> = []
    on('ui.open', ($, e) => {
      opens.push(e as { id: string; title?: string })
      return { value: { isPlaced: true } } as never
    })
    on('ui.close', ($, e) => {
      closes.push(e as { id: string })
      return { value: undefined } as never
    })
    on('command.register', () => ({ value: { command: COMMAND_NAME } }))
    await bootstrap($, on)

    const r1 = await $.command.run(COMMAND_RUN)
    expect(r1.text).toBe('timing: opened.')
    expect(opens[0]?.id).toBe(PANE_ID)
    expect(opens[0]?.title).toBe('Turn timing')

    const r2 = await $.command.run(COMMAND_RUN)
    expect(r2.text).toBe('timing: closed.')
    expect(closes[0]?.id).toBe(PANE_ID)
  })
})

// ---------------------------------------------------------------------------
// The band
// ---------------------------------------------------------------------------

describe('the AbovePrompt band', () => {
  test('draws nothing of its own when no turn has been measured', async ($, on) => {
    on('command.register', () => ({ value: { command: COMMAND_NAME } }))
    await bootstrap($, on)

    const band = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'AbovePrompt',
        requestId: 'band',
        props: BAND_PROPS,
      }),
    )
    expect(textsOf(band).find((t) => t.startsWith('⏱'))).toBeUndefined()
  })

  test('shows the turn\'s buckets and a [Details] button', async ($, on) => {
    on('command.register', () => ({ value: { command: COMMAND_NAME } }))
    await bootstrap($, on)
    await runTurn($)

    const band = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'AbovePrompt',
        requestId: 'band',
        props: BAND_PROPS,
      }),
    )

    const title = findAll(band, 'Text').find(
      (t) => typeof t.children?.[0] === 'string' && t.children[0].startsWith('⏱'),
    )
    expect(title).toBeDefined()
    const text = asText(title)
    expect(text).toContain('turn:')
    expect(text).toContain('model ')
    expect(text).toContain('tools ')
    expect(title?.props?.color).toBe('magenta')

    const btn = findAll(band, 'Button').find((b) => b.props?.label === 'Details')
    expect(btn).toBeDefined()
    expect(btn?.props?.variant).toBe('primary')
  })

  test('hides while the Pane is open', async ($, on) => {
    on('ui.open', () => ({ value: { isPlaced: true } } as never))
    on('ui.close', () => ({ value: undefined } as never))
    on('command.register', () => ({ value: { command: COMMAND_NAME } }))
    await bootstrap($, on)
    await runTurn($)
    await $.command.run(COMMAND_RUN)

    const band = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'AbovePrompt',
        requestId: 'band',
        props: BAND_PROPS,
      }),
    )
    expect(textsOf(band).find((t) => t.startsWith('⏱'))).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

describe('the Pane', () => {
  test('renders an empty state when nothing has been measured', async ($, on) => {
    on('command.register', () => ({ value: { command: COMMAND_NAME } }))
    await bootstrap($, on)

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: PANE_PROPS,
      }),
    )
    expect(textsOf(pane).find((t) => t.includes('no turns measured yet'))).toBeDefined()
  })

  test('renders one block per turn with the buckets', async ($, on) => {
    on('command.register', () => ({ value: { command: COMMAND_NAME } }))
    await bootstrap($, on)
    await runTurn($)

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: PANE_PROPS,
      }),
    )

    const texts = textsOf(pane)
    expect(texts.find((t) => t.startsWith('model'))).toBeDefined()
    expect(texts.find((t) => t.startsWith('tools'))).toBeDefined()
    expect(texts.find((t) => t.startsWith('tokens'))).toBeDefined()
    // The prompt the turn began with labels the block.
    expect(texts.find((t) => t === 'find the bug')).toBeDefined()
    // The header carries the turn count and a Close button.
    expect(texts.find((t) => t === '1 turn')).toBeDefined()
    const close = findAll(pane, 'Button').find((b) => b.props?.label === 'Close')
    expect(close).toBeDefined()
    expect(close?.props?.variant).toBe('primary')
  })

  test('a measured tool call shows up in the pane', async ($, on) => {
    on('command.register', () => ({ value: { command: COMMAND_NAME } }))
    await bootstrap($, on)

    // The tool call happens INSIDE the turn, so the profiler attributes it
    // to the turn that is running.
    await $.turn.start({ text: 'find the bug', turnId: 'turn-1' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    await $.turn.complete({
      answer: 'done',
      durationMs: 1000,
      isAborted: false,
      turnId: 'turn-1',
      reason: 'answer',
    })

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: PANE_PROPS,
      }),
    )
    const texts = textsOf(pane)
    expect(texts.find((t) => t.startsWith('tools'))).toBeDefined()
    // The tools row counts the call the turn made.
    expect(texts.find((t) => t.startsWith('1 call'))).toBeDefined()
  })
})
