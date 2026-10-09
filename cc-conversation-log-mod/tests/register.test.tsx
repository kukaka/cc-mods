// Tests for hooks/register.tsx — band render, pane render, command toggle.
//
// The substantive logic lives in hooks/format.ts and is exercised by
// format.test.ts. Here we test the glue layer that ties the engine's
// events to that logic.
//
// Test-kit pattern (per the engine docs):
//   * `on(event, ($, e, next) => next(e))` is a fall-through — our plugin's
//     handler runs and its return value flows back to the test.
//   * `on(event, ($, e) => { ... return sentinel })` REPLACES our handler
//     for that event. We use it sparingly, only when we want to assert on
//     an event being fired (e.g. command.register) rather than on its
//     handler's output.
//   * The kit strips `onPress` from rendered trees, so we can read the
//     tree shape but not invoke the buttons. Assertions focus on props.
//
// Module-local state (paneOpen, windowSize, expandedTools) resets on
// `$.session.start`, so each test calls that first to start from a
// known-clean baseline. The kit gives every `test(...)` a fresh `$`.
//
// Element shape: a `Box({...})` call returns an object with `type`,
// `props` (the prop values), and a top-level `children` (extracted from
// the children prop). The pattern is shared with cc-file-history-mod's
// tests.
//
// Run with `claude plugin test ./cc-conversation-log-mod`.

import { describe, expect, test } from 'claude-code/testing'

import { register } from '../hooks/register'

// -----------------------------------------------------------------------
// Element-tree types — narrow shapes the tests assert against.
// -----------------------------------------------------------------------

type Element = {
  type: string
  props?: Record<string, unknown>
  children?: unknown[]
}

type Tree = Element | null | undefined

function asElement(v: unknown): Element {
  if (!v || typeof v !== 'object' || typeof (v as { type?: unknown }).type !== 'string') {
    throw new Error(`expected an element tree, got: ${typeof v} (${JSON.stringify(v)})`)
  }
  return v as Element
}

function asText(v: unknown): string {
  // Text element carries its content as `children: [string, ...]`.
  const e = asElement(v)
  const first = e.children?.[0]
  if (typeof first !== 'string') {
    throw new Error(`expected Text element, children=[string]; got ${JSON.stringify(e)}`)
  }
  return first
}

function findAll(tree: Tree, type: string, into: Element[] = []): Element[] {
  if (!tree) return into
  if (tree.type === type) into.push(tree)
  for (const c of tree.children ?? []) {
    if (c && typeof c === 'object' && typeof (c as { type?: unknown }).type === 'string') {
      findAll(c as Element, type, into)
    }
  }
  return into
}

// -----------------------------------------------------------------------
// Fixtures.
// -----------------------------------------------------------------------

const PANE_ID = 'cc-conversation-log-mod-pane'
const COMMAND_NAME = 'history'

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 20 },
  view: { agentId: 'main' },
} as const

type SessionMessage = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: Array<{
    tool_use_id: string
    tool: string
    input: Record<string, unknown>
    text?: string
    isError?: true
  }>
}

function userMsg(text: string): SessionMessage {
  return { role: 'user', text }
}

function assistantMsg(
  text: string,
  toolUses: SessionMessage['toolUses'] = [],
): SessionMessage {
  return { role: 'assistant', text, toolUses }
}

/** Stub the engine's pass-through. Both our AbovePrompt and Pane handlers
 *  get to run when the test calls `$.ui.render(...)`. */
function passThrough(on: (e: string, h: unknown) => unknown) {
  on('ui.render', ($, e: { component: string }, next) => next(e))
}

// -----------------------------------------------------------------------
// AbovePrompt band
// -----------------------------------------------------------------------

describe('AbovePrompt band', () => {
  test('session.start registers the /history command', async ($, on) => {
    const registered: Array<{ name: string; description: string }> = []
    on('command.register', ($, e) => {
      registered.push(e as { name: string; description: string })
      return { value: undefined }
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    expect(registered).toEqual([
      {
        name: COMMAND_NAME,
        description: 'Open / close the conversation log pane',
      },
    ])
  })

  test('band yields (returns null) when the transcript is empty', async ($, on) => {
    on('session.messages', () => ({ value: [] }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const out = await $.ui.render({
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })
    // Our handler returns null on empty; no other AbovePrompt handler is
    // registered, so the resolve is null. Confirms the "0 / 0" stub is
    // not rendered on a fresh session.
    expect(out).toBeNull()
  })

  test('band shows counts + a [ View ] button when there are messages', async ($, on) => {
    on('session.messages', () => ({
      value: [
        userMsg('Hi'),
        assistantMsg('Hello, how can I help?', []),
        userMsg('Tell me a joke'),
        assistantMsg(
          'Why did the chicken cross the road?',
          [
            {
              tool_use_id: 'tu-1',
              tool: 'Bash',
              input: { command: 'echo "joke"' },
              text: 'joke',
            },
          ],
        ),
      ],
    }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const band = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'AbovePrompt',
        props: BAND_PROPS,
      }),
    )

    expect(band.type).toBe('Box')
    expect(band.props?.flexDirection).toBe('row')

    const titleText = findAll(band, 'Text').find((t) =>
      typeof t.children?.[0] === 'string' && t.children[0].startsWith('▶ History:'),
    )
    expect(titleText).toBeDefined()
    expect(asText(titleText)).toBe('▶ History: 2 user, 2 assistant, 1 tool')
    expect(titleText?.props?.color).toBe('magenta')
    expect(titleText?.props?.bold).toBe(true)

    const viewBtn = findAll(band, 'Button').find((b) => b.props?.label === 'View')
    expect(viewBtn).toBeDefined()
    // Hotkey + variant assertions: 'h' is our hotkey (cc-file-history-mod
    // uses 'v'), and `variant: 'primary'` is the engine-quirk workaround
    // for Buttons on the Pane's dark chrome.
    expect(viewBtn?.props?.hotkey).toBe('h')
    expect(viewBtn?.props?.variant).toBe('primary')
  })

  test('band hides when the Pane is open (no duplicate chrome)', async ($, on) => {
    on('session.messages', () => ({ value: [userMsg('a'), assistantMsg('b')] }))
    passThrough(on)
    on('ui.open', () => ({ value: { isPlaced: true } } as never))
    on('ui.close', () => ({ value: undefined } as never))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    // Open the Pane — flips our `paneOpen` flag via the success path.
    await $.command.run({ command: COMMAND_NAME, args: '' })

    const out = await $.ui.render({
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })
    expect(out).toBeNull()
  })

  test('band reads the transcript on every render (no stale snapshot)', async ($, on) => {
    // Empty at first render; populated on the second. Two calls, two
    // answers — proves `renderBand` consults the live transcript rather
    // than caching an early empty snapshot.
    let messages: SessionMessage[] = []
    on('session.messages', () => ({ value: messages }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const empty = await $.ui.render({
      surface: 'terminal',
      component: 'AbovePrompt',
      props: BAND_PROPS,
    })
    expect(empty).toBeNull()

    messages = [userMsg('first')]
    const filled = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'AbovePrompt',
        props: BAND_PROPS,
      }),
    )
    const title = findAll(filled, 'Text').find((t) =>
      typeof t.children?.[0] === 'string' && t.children[0].startsWith('▶ History:'),
    )
    expect(title).toBeDefined()
    expect(asText(title)).toBe('▶ History: 1 user, 0 assistant, 0 tools')
  })
})

// -----------------------------------------------------------------------
// Pane render
// -----------------------------------------------------------------------

describe('Pane', () => {
  test('renders an empty-state tree when the transcript is empty', async ($, on) => {
    on('session.messages', () => ({ value: [] }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: { bodyColumns: 80 },
      }),
    )
    expect(pane.type).toBe('Box')
    expect(
      findAll(pane, 'Text').find(
        (t) => t.children?.[0] === 'no messages yet — send a prompt first.',
      ),
    ).toBeDefined()
  })

  test('renders one row per message with role-coloured headers', async ($, on) => {
    on('session.messages', () => ({
      value: [userMsg('Hello'), assistantMsg('World!')],
    }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: { bodyColumns: 80 },
      }),
    )
    const texts = findAll(pane, 'Text')
    expect(texts.find((t) => t.children?.[0] === 'Hello')).toBeDefined()
    expect(texts.find((t) => t.children?.[0] === 'World!')).toBeDefined()
    // Header rows carry the role + ordinal.
    expect(texts.find((t) => t.children?.[0] === 'You — 1st')).toBeDefined()
    expect(texts.find((t) => t.children?.[0] === 'Claude — 2nd')).toBeDefined()
  })

  test('renders a [▶ N tools] disclosure for assistant messages with tool calls', async ($, on) => {
    on('session.messages', () => ({
      value: [
        userMsg('Read me foo'),
        assistantMsg('Here you go.', [
          {
            tool_use_id: 'tu-1',
            tool: 'Read',
            input: { file_path: '/foo' },
            text: 'foo contents',
          },
          {
            tool_use_id: 'tu-2',
            tool: 'Bash',
            input: { command: 'ls' },
            text: '',
          },
          {
            tool_use_id: 'tu-3',
            tool: 'Bash',
            input: { command: 'pwd' },
            text: '/work',
          },
        ]),
      ],
    }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: { bodyColumns: 80 },
      }),
    )

    const buttons = findAll(pane, 'Button')
    const groupBtn = buttons.find((b) => b.props?.label === '▶ 3 tools')
    expect(groupBtn).toBeDefined()
    // globalIndex of the assistant message is 1 (0=user, 1=assistant).
    expect(groupBtn?.props?.key).toBe('toggle-tools-1')
  })

  test('shows [Load 50 earlier · N more older] when the page is short of full', async ($, on) => {
    // 60 messages → window=50 → 10 more older, ≥ PAGE_SIZE so the
    // disclosure shows the "Load 50 earlier" form, not "Jump to oldest".
    const messages: SessionMessage[] = []
    for (let i = 0; i < 60; i++) {
      messages.push(i % 2 === 0 ? userMsg(`u${i}`) : assistantMsg(`a${i}`))
    }
    on('session.messages', () => ({ value: messages }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: { bodyColumns: 80 },
      }),
    )

    const buttons = findAll(pane, 'Button')
    const loadBtn = buttons.find(
      (b) =>
        typeof b.props?.label === 'string' && b.props.label.startsWith('Load 50 earlier'),
    )
    expect(loadBtn).toBeDefined()
    expect(loadBtn?.props?.variant).toBe('primary')
    expect(loadBtn?.props?.key).toBe('load-earlier')
  })

  test('switches to [ Jump to oldest ] when fewer than PAGE_SIZE remain', async ($, on) => {
    // 55 messages → window=50 → 5 more older, < PAGE_SIZE → "Jump to oldest".
    const messages: SessionMessage[] = []
    for (let i = 0; i < 55; i++) {
      messages.push(i % 2 === 0 ? userMsg(`u${i}`) : assistantMsg(`a${i}`))
    }
    on('session.messages', () => ({ value: messages }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: { bodyColumns: 80 },
      }),
    )

    const buttons = findAll(pane, 'Button')
    const jumpBtn = buttons.find((b) => b.props?.label === 'Jump to oldest')
    expect(jumpBtn).toBeDefined()
    // No "Load 50 earlier" button when remaining < PAGE_SIZE.
    const loadBtn = buttons.find(
      (b) =>
        typeof b.props?.label === 'string' && b.props.label.startsWith('Load 50 earlier'),
    )
    expect(loadBtn).toBeUndefined()
  })

  test('omits the paging control when the page already covers everything', async ($, on) => {
    // 10 messages, default window=50 — already fits.
    const messages: SessionMessage[] = []
    for (let i = 0; i < 10; i++) {
      messages.push(i % 2 === 0 ? userMsg(`u${i}`) : assistantMsg(`a${i}`))
    }
    on('session.messages', () => ({ value: messages }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: { bodyColumns: 80 },
      }),
    )

    const buttons = findAll(pane, 'Button')
    expect(buttons.find((b) => b.props?.key === 'load-earlier')).toBeUndefined()
    expect(
      findAll(pane, 'Text').find(
        (t) =>
          typeof t.children?.[0] === 'string' &&
          t.children[0].startsWith('Showing all 10 messages'),
      ),
    ).toBeDefined()
  })

  test('rendering the Pane does NOT grow the page window by itself', async ($, on) => {
    // Three renders, default window=50 throughout. The Load-earlier
    // button should still be there on the third render — page growth is
    // only via an explicit button click, not implicit by re-rendering.
    const messages: SessionMessage[] = []
    for (let i = 0; i < 60; i++) {
      messages.push(i % 2 === 0 ? userMsg(`u${i}`) : assistantMsg(`a${i}`))
    }
    on('session.messages', () => ({ value: messages }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    for (let i = 0; i < 3; i++) {
      const pane = asElement(
        await $.ui.render({
          surface: 'terminal',
          component: 'Pane',
          requestId: PANE_ID,
          props: { bodyColumns: 80 },
        }),
      )
      const loadBtn = findAll(pane, 'Button').find(
        (b) =>
          typeof b.props?.label === 'string' && b.props.label.startsWith('Load 50 earlier'),
      )
      expect(loadBtn).toBeDefined()
    }
  })

  test('header carries the total counts and a [ Close ] primary button', async ($, on) => {
    on('session.messages', () => ({
      value: [userMsg('a'), assistantMsg('b'), userMsg('c'), assistantMsg('d', [])],
    }))
    passThrough(on)

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

    const pane = asElement(
      await $.ui.render({
        surface: 'terminal',
        component: 'Pane',
        requestId: PANE_ID,
        props: { bodyColumns: 80 },
      }),
    )

    // "2 user, 2 assistant, 0 tools" lives in the header row.
    expect(
      findAll(pane, 'Text').find(
        (t) => t.children?.[0] === '2 user, 2 assistant, 0 tools',
      ),
    ).toBeDefined()

    const buttons = findAll(pane, 'Button')
    const closeBtn = buttons.find((b) => b.props?.label === 'Close')
    expect(closeBtn).toBeDefined()
    expect(closeBtn?.props?.variant).toBe('primary')
    expect(closeBtn?.props?.key).toBe('close')
  })
})

// -----------------------------------------------------------------------
// Slash command
// -----------------------------------------------------------------------

describe('slash command', () => {
  test('/history opens the Pane on first call, closes on second', async ($, on) => {
    passThrough(on)
    const opens: Array<{
      id: string
      title?: string
      focus?: boolean
      closeOnEscape?: boolean
    }> = []
    const closes: Array<{ id: string }> = []
    on('ui.open', ($, e) => {
      opens.push(e as { id: string; title?: string; focus?: boolean; closeOnEscape?: boolean })
      return { value: { isPlaced: true } } as never
    })
    on('ui.close', ($, e) => {
      closes.push(e as { id: string })
      return { value: undefined } as never
    })

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    expect(opens.length).toBe(0)
    expect(closes.length).toBe(0)

    const r1 = await $.command.run({ command: COMMAND_NAME, args: '' })
    expect(r1.text).toBe('history: opened.')
    expect(opens.length).toBe(1)
    expect(opens[0]?.id).toBe(PANE_ID)
    expect(opens[0]?.title).toBe('Conversation log')
    expect(opens[0]?.focus).toBe(true)
    expect(opens[0]?.closeOnEscape).toBe(true)
    expect(closes.length).toBe(0)

    const r2 = await $.command.run({ command: COMMAND_NAME, args: '' })
    expect(r2.text).toBe('history: closed.')
    expect(opens.length).toBe(1)
    expect(closes.length).toBe(1)
    expect(closes[0]?.id).toBe(PANE_ID)
  })

  test('classic.SessionStart { clear | resume | fork } resets paneOpen', async ($, on) => {
    // Each of /clear, /resume, /branch fires classic.SessionStart. Our
    // handler resets paneOpen, so the band re-shows on the next render.
    on('session.messages', () => ({ value: [userMsg('x'), assistantMsg('y')] }))
    passThrough(on)
    on('ui.open', () => ({ value: { isPlaced: true } } as never))
    on('ui.close', () => ({ value: undefined } as never))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    // Open the Pane — flips paneOpen=true.
    await $.command.run({ command: COMMAND_NAME, args: '' })

    for (const source of ['clear', 'resume', 'fork'] as const) {
      await $.classic.SessionStart({ source })

      // With paneOpen reset, the band re-appears. (If the band still
      // hid, the test would fail because `out` would be null.)
      const after = await $.ui.render({
        surface: 'terminal',
        component: 'AbovePrompt',
        props: BAND_PROPS,
      })
      expect(after).not.toBeNull()
      const band = asElement(after)
      const title = findAll(band, 'Text').find((t) =>
        typeof t.children?.[0] === 'string' && t.children[0].startsWith('▶ History:'),
      )
      expect(title).toBeDefined()

      // Re-open so the next iteration of the loop has paneOpen=true again.
      await $.command.run({ command: COMMAND_NAME, args: '' })
    }
  })
})

// -----------------------------------------------------------------------
// `register` function — confirms the hook set the engine will dispatch to.
// -----------------------------------------------------------------------

describe('register function', () => {
  test('is a function', () => {
    expect(typeof register).toBe('function')
  })

  test('registers exactly 6 handlers across the documented event names', () => {
    // Track the (event-pattern, matcher) pair — `on('classic.SessionStart',
    // { source: […] }, …)` carries the matcher as its second arg. We push
    // `matcher ?? event` so a literal match (like `'session.start'`) and a
    // matcher-object registration (like `{ source: ['clear', ...] }`)
    // both end up in the same array, queryable as strings.
    const seen: Array<string | { source: string[] }> = []
    const stubOn: Parameters<typeof register>[0] = ((event, matcher, _handler) => {
      seen.push((matcher ?? event) as never)
      return undefined as never
    }) as Parameters<typeof register>[0]

    register(stubOn)
    expect(seen.length).toBe(6)
    const names = seen.map((m) => (typeof m === 'string' ? m : JSON.stringify(m)))
    expect(names).toContain('session.start')
    expect(names).toContain(JSON.stringify({ source: ['clear', 'resume', 'fork'] }))
    expect(names).toContain('command.run')
    expect(names).toContain('ui.render')
    expect(names).toContain('ui.close')
  })
})
