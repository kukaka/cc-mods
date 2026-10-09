// cc-conversation-log-mod — read-only Pane of every user/assistant message
// in the current session, with collapsible tool-call groups and paged
// loading of older turns.
//
// Three surfaces:
//   - AbovePrompt band (auto-shown when there is anything to show):
//       `▶ History: 5 user / 5 assistant / 14 tools   [ View (h) ]`
//     Hidden while the Pane is open (chrome already shows the title).
//   - Pane (on demand, via the band's button or /history):
//     One row per message in the current session, newest at the bottom.
//     Each assistant message with tool calls collapses them into
//     `[ ▶ 3 tools ]`; click to expand into a per-tool block with input +
//     result. A `[ Load 50 earlier ]` button at the top grows the window
//     until the whole transcript is in view.
//   - Slash command `/history`: toggles the Pane.
//
// All data comes from `$.session.messages()` — re-fetched on each Pane
// render so a freshly-finished assistant turn is visible the moment the
// user clicks View. No module-local cache (the engine call is cheap; a
// cache adds complexity without benefit at this size).
//
// Module-local state (resets on hot reload):
//   paneOpen    — mirror of the engine's own Pane placement. `ui.close`
//                 keeps this honest when the user closes via X / Escape.
//   windowSize  — number of newest messages to render; grows on each
//                 `[ Load earlier ]` click up to the transcript length.
//   expandedTools — Set of "<msgIndex>:<tool_use_id>" we already opened.
//                 Smaller than storing the whole Map<number, Set> — strings
//                 compose naturally with React-style keys.
//
// Hard resets happen on session.start AND on classic.SessionStart
// { clear|resume|fork } — same shape cc-file-history-mod uses, since
// /clear / /resume / /branch replace the conversation without firing a
// fresh session.start.

import type { EngineInterface, Register } from 'claude-code'

import {
  ASSISTANT_NO_TEXT,
  MAX_TEXT_CHARS,
  PAGE_SIZE,
  countMessages,
  earlierCount,
  ordinal,
  pageLatest,
  roleColor,
  roleIcon,
  toolIcon,
  toolLabel,
  toolResultHead,
  toolResultSummary,
  truncateText,
} from './format'

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------

/** Engine Pane id; must be 1-64 chars of letters/digits/`_`/`-`. */
const PANE_ID = 'cc-conversation-log-mod-pane'

/** Slash command shown in the engine's command list. */
const COMMAND_NAME = 'history'

/** Default number of newest messages the Pane shows on first open.
 *  Grows on each `[ Load earlier ]` click in PAGE_SIZE steps. */
const DEFAULT_WINDOW = 50

let paneOpen = false
let windowSize = DEFAULT_WINDOW
const expandedTools = new Set<string>()

function resetState() {
  paneOpen = false
  windowSize = DEFAULT_WINDOW
  expandedTools.clear()
}

// ---------------------------------------------------------------------------
// Element type — narrow alias to keep the JSX tree short and the type
// surface easy to read.
// ---------------------------------------------------------------------------

type El = (props: Record<string, unknown> & { children?: unknown }) => unknown
type Elements = {
  Box: El
  Text: El
  Button: El
  Code: El
  Markdown: El
}

function resolve($: EngineInterface, e: { surface: string }): Elements {
  return $.ui.resolve(e as never) as unknown as Elements
}

// ---------------------------------------------------------------------------
// Page / window mutation helpers
// ---------------------------------------------------------------------------

// Grow the window by PAGE_SIZE — capped by the caller when the actual
// transcript length is known. We don't take the total as a parameter
// here because `loadEarlier` is called inside a Button `onPress` where
// `messages.length` was captured at render time; we trust that the next
// render will re-cap it via `pageLatest` (which slices to a fresh array).
const loadEarlier = (): void => {
  windowSize = windowSize + PAGE_SIZE
}

const jumpToOldest = (currentTotal: number): void => {
  windowSize = currentTotal
}

const resetWindow = (): void => {
  windowSize = DEFAULT_WINDOW
  expandedTools.clear()
}

// ---------------------------------------------------------------------------
// One message's row — used by the Pane render below.
//
// Shape of `message` is the engine's `SessionMessage` (see
// `.claude-plugin/types/claude-code/index.d.ts:11067`): `{ role, text,
// toolUses, toolResults? }`. `toolUses` is required (possibly empty) on
// the engine type, but we declare it optional here so the Pane render can
// pass through a `filter()` result without an explicit narrowing step
// (the runtime check `toolUses?.length ?? 0` is what protects callers).
// ---------------------------------------------------------------------------

type Message = {
  role: 'user' | 'assistant'
  text: string
  toolUses?: Array<{
    tool_use_id: string
    tool: string
    input: Record<string, unknown>
    text?: string
    result?: unknown
    isError?: true
  }>
}

type ToolUse = NonNullable<Message['toolUses']>[number]

function renderMessage(
  $: EngineInterface,
  $el: Elements,
  message: Message,
  globalIndex: number,
): unknown {
  const isUser = message.role === 'user'
  const toolCount = message.toolUses?.length ?? 0

  // Header row — role icon + ordinal position + turn count (e.g. "3rd / 5")
  // is intentionally absent (we'd need to count user turns separately and
  // the band already shows "5 user / 5 assistant"). The ordinal alone is
  // monotonic and stable across renders.
  const header = $el.Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      $el.Text({ children: roleIcon(message.role) }),
      $el.Text({
        bold: true,
        color: roleColor(message.role),
        children: isUser ? `You — ${ordinal(globalIndex + 1)}` : `Claude — ${ordinal(globalIndex + 1)}`,
      }),
    ],
  })

  // Body — text first, then collapsible tool calls for assistants.
  const text = message.text?.trim()
  const hasText = !!text && text.length > 0
  const isAssistantNoText = !isUser && !hasText && toolCount > 0
  const body: unknown[] = []

  if (hasText) {
    const truncated = truncateText(message.text, MAX_TEXT_CHARS)
    // Markdown for assistants — same engine styling as their in-transcript
    // rows. Plain Text for users — they typed it verbatim, no need to
    // re-parse markdown and risk rendering < > differently than the
    // transcript did.
    if (isUser) {
      body.push($el.Text({ wrap: 'wrap', children: truncated }))
    } else {
      body.push(
        $el.Markdown({
          key: `msg-text-${globalIndex}`,
          text: truncated,
        }),
      )
    }
  } else if (isAssistantNoText) {
    body.push(
      $el.Text({ dimColor: true, children: ASSISTANT_NO_TEXT }),
    )
  }

  if (!isUser && toolCount > 0) {
    body.push(renderToolGroup($, $el, message.toolUses!, globalIndex))
  }

  return $el.Box({
    flexDirection: 'column',
    paddingX: 1,
    paddingY: 0,
    gap: 1,
    children: [header, ...body],
  })
}

// ---------------------------------------------------------------------------
// Tool group — collapsed "[ ▶ 3 tools ]" → expanded rows with input/result.
// ---------------------------------------------------------------------------

function renderToolGroup(
  $: EngineInterface,
  $el: Elements,
  toolUses: ToolUse[],
  globalIndex: number,
): unknown {
  // "expanded" reads as "every tool in the group is open". A partially-
  // expanded group (some open, some closed) reads as collapsed for the
  // disclosure icon — clicking it should expand-all, not collapse. The
  // [ Show/Hide ] button per tool handles fine-grained toggling.
  const expanded = toolUses.every((t) =>
    expandedTools.has(`${globalIndex}:${t.tool_use_id}`),
  )

  const toggleGroup = (): void => {
    if (expanded) {
      // Collapse: clear every tool's slot.
      for (const t of toolUses) {
        expandedTools.delete(`${globalIndex}:${t.tool_use_id}`)
      }
    } else {
      // Expand: register every tool's slot up front so the renderer
      // recomputes and shows the rows immediately. Partial→full collapse
      // is the more useful direction than leaving the partial state.
      for (const t of toolUses) {
        expandedTools.add(`${globalIndex}:${t.tool_use_id}`)
      }
    }
    $.ui.invalidate('ui.render')
  }

  const toggleOne = (toolUseId: string): void => {
    const key = `${globalIndex}:${toolUseId}`
    if (expandedTools.has(key)) expandedTools.delete(key)
    else expandedTools.add(key)
    $.ui.invalidate('ui.render')
  }

  // Group toggle button. `plain: true` so the leading `▶`/`▼` reads as
  // a disclosure glyph on a single line, not a labelled primary button.
  const summary = $el.Button({
    key: `toggle-tools-${globalIndex}`,
    label: expanded ? `▼ ${toolUses.length} tool${toolUses.length === 1 ? '' : 's'}` : `▶ ${toolUses.length} tool${toolUses.length === 1 ? '' : 's'}`,
    plain: true,
    dimColor: true,
    onPress: toggleGroup,
  })

  if (expanded) {
    const rows = toolUses.map((t) => renderToolRow($, $el, t, globalIndex, toggleOne))
    return $el.Box({
      flexDirection: 'column',
      paddingLeft: 2,
      gap: 0,
      children: [summary, ...rows],
    })
  }

  return summary
}

// ---------------------------------------------------------------------------
// One tool row — collapsed shows icon + label + result summary, expanded
// adds the full input record and result text.
// ---------------------------------------------------------------------------

function renderToolRow(
  $: EngineInterface,
  $el: Elements,
  toolUse: ToolUse,
  globalIndex: number,
  toggleOne: (toolUseId: string) => void,
): unknown {
  const key = `${globalIndex}:${toolUse.tool_use_id}`
  const isOpen = expandedTools.has(key)
  const summary = toolResultSummary(
    toolUse.text,
    toolUse.isError,
    toolUse.text !== undefined || toolUse.isError === true,
  )

  const header = $el.Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      $el.Text({ children: toolIcon(toolUse.tool) }),
      $el.Text({ children: toolLabel(toolUse.tool, toolUse.input) }),
      $el.Text({ dimColor: true, children: ' ' + summary }),
      $el.Box({ flexGrow: 1 }),
      $el.Button({
        key: `toggle-tool-${toolUse.tool_use_id}`,
        label: isOpen ? 'Hide' : 'Show',
        plain: true,
        dimColor: true,
        onPress: () => toggleOne(toolUse.tool_use_id),
      }),
    ],
  })

  if (!isOpen) return header

  // Expanded body — input first, then result. Both as `Code` (the default
  // `format: 'source'` renders JSON / shell output cleanly). Truncated to
  // MAX_TEXT_CHARS each so a 50KB Bash result doesn't blow up the pane.
  const body: unknown[] = []
  const inputText = safeStringify(toolUse.input)
  if (inputText) {
    body.push(
      $el.Text({ dimColor: true, bold: true, children: 'input' }),
    )
    body.push(
      $el.Code({
        key: `input-${toolUse.tool_use_id}`,
        source: truncateText(inputText, MAX_TEXT_CHARS),
      }),
    )
  }
  const resultText = toolUse.text ?? ''
  if (resultText) {
    body.push(
      $el.Text({ dimColor: true, bold: true, children: 'result' }),
    )
    body.push(
      $el.Code({
        key: `result-${toolUse.tool_use_id}`,
        source: truncateText(resultText, MAX_TEXT_CHARS),
      }),
    )
  } else if (toolUse.isError === true) {
    body.push(
      $el.Text({ dimColor: true, children: '(no result text on error)' }),
    )
  } else {
    body.push(
      $el.Text({
        dimColor: true,
        children: toolResultHead(resultText, 0) || '(in flight)',
      }),
    )
  }

  return $el.Box({
    flexDirection: 'column',
    paddingLeft: 2,
    gap: 0,
    children: [header, ...body],
  })
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

// ---------------------------------------------------------------------------
// Pane render
// ---------------------------------------------------------------------------

async function renderPane($: EngineInterface, e: { surface: string }): Promise<unknown> {
  const $el = resolve($, e)

  const raw = await $.session.messages()
  // Filter to user + assistant rows only — the engine can store other
  // row kinds (system, attachment), and we don't want noise in the view.
  const messages = (raw as Message[]).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant'),
  )

  const counts = countMessages(messages)
  const page = pageLatest(messages, windowSize)
  const olderShown = Math.max(0, messages.length - windowSize)
  // Cap how much "older" we can load — re-fetching the same transcript and
  // getting a million rows is fine, but a single huge transcript cuts the
  // engine's own read cost dramatically. PAGE_SIZE matches the load step.
  const earlierAvailable = earlierCount(messages.length, windowSize)
  const atOldest = olderShown === 0

  // Header.
  const closePane = async (): Promise<void> => {
    paneOpen = false
    await $.ui.close({ id: PANE_ID })
  }
  const refresh = (): void => {
    resetWindow()
    $.ui.invalidate('ui.render')
  }

  const header = $el.Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      $el.Text({ children: '📜' }),
      $el.Text({ bold: true, color: 'magenta', children: 'Conversation log' }),
      $el.Text({
        dimColor: true,
        children: `${counts.user} user, ${counts.assistant} assistant, ${counts.tools} tool${counts.tools === 1 ? '' : 's'}`,
      }),
      $el.Box({ flexGrow: 1 }),
      $el.Button({
        key: 'refresh',
        label: 'Refresh',
        plain: true,
        dimColor: true,
        onPress: refresh,
      }),
      $el.Button({
        key: 'close',
        label: 'Close',
        variant: 'primary',
        onPress: closePane,
      }),
    ],
  })

  // Empty state.
  if (messages.length === 0) {
    return $el.Box({
      flexDirection: 'column',
      paddingX: 1,
      gap: 1,
      children: [
        header,
        $el.Text({ dimColor: true, children: 'no messages yet — send a prompt first.' }),
      ],
    })
  }

  // Paging controls (top of the list, before the messages themselves).
  // The whole pane scrolls as one unit, so "earlier" lives ABOVE the
  // current page; reading top-to-bottom is oldest-on-top.
  const paging: unknown[] = []
  if (!atOldest) {
    const remaining = messages.length - windowSize
    // When the remaining load is smaller than PAGE_SIZE, a single click
    // would clear it — so just label the button "Jump to oldest" instead
    // of pretending one more page is hidden. (Earlier `earlierAvailable`
    // is exposed but only used for the cap on the onPress side; here we
    // want the user-facing wording.)
    const label =
      remaining < PAGE_SIZE
        ? 'Jump to oldest'
        : `Load ${PAGE_SIZE} earlier · ${remaining} more older`
    paging.push(
      $el.Box({
        flexDirection: 'row',
        gap: 1,
        children: [
          $el.Button({
            key: 'load-earlier',
            label,
            variant: 'primary',
            onPress: () => {
              // `earlierAvailable === 0` would be unreachable given the
              // branch above — but keep the guard so a future change to
              // PAGE_SIZE / windowed semantics still terminates cleanly.
              if (earlierAvailable === 0) {
                jumpToOldest(messages.length)
              } else {
                loadEarlier()
              }
              $.ui.invalidate('ui.render')
            },
          }),
        ],
      }),
    )
    paging.push(
      $el.Text({
        dimColor: true,
        children: `Showing ${page.length} of ${messages.length} messages (newest at bottom).`,
      }),
    )
  } else {
    paging.push(
      $el.Text({
        dimColor: true,
        children: `Showing all ${messages.length} messages (newest at bottom).`,
      }),
    )
  }

  // The message rows. Each row gets its global index so the
  // expandedTools set stays stable across re-renders that change the page
  // window (a tool expanded while showing page 1 should stay expanded
  // when the user pages back later).
  const rows = page.map((m, i) => {
    const globalIndex = messages.length - page.length + i
    return renderMessage($, $el, m, globalIndex)
  })

  return $el.Box({
    flexDirection: 'column',
    paddingX: 1,
    gap: 1,
    children: [header, ...paging, ...rows],
  })
}

// ---------------------------------------------------------------------------
// AbovePrompt band — a single row with counts + [ View ].
//
// Same coexistence pattern cc-file-history-mod uses: yield via next(e) when
// there's nothing of our own to draw, otherwise compose our tree after
// `next(e)` in a column so the engine picks both up.
// ---------------------------------------------------------------------------

type BandRenderEvent = {
  surface: string
  props?: { bodyColumns?: number }
  hasSurvey?: boolean
}

async function renderBand($: EngineInterface, e: BandRenderEvent): Promise<unknown | null> {
  const $el = resolve($, e)
  const raw = await $.session.messages()
  const messages = (raw as Message[]).filter(
    (m) => m && (m.role === 'user' || m.role === 'assistant'),
  )
  // Hide the band entirely when there's nothing to show — the band
  // existing with "0 / 0" would just be visual noise on a fresh session.
  if (messages.length === 0) return null
  // And hide while the Pane is open — the Pane's header already shows
  // the counts and the user has explicitly chosen to look at the full
  // view, so a duplicate row above the prompt reads as clutter.
  if (paneOpen) return null

  const c = countMessages(messages)

  const openPane = async (): Promise<void> => {
    try {
      const r = await $.ui.open({
        id: PANE_ID,
        title: 'Conversation log',
        focus: true,
        closeOnEscape: true,
      })
      paneOpen = r.isPlaced === true
      if (!r.isPlaced) {
        const reason = 'reason' in r ? String(r.reason) : 'unknown'
        const hint = reason.includes('below 110 columns') ? ' — type /history once to unlock' : ''
        $.ui.toast(`history: pane open refused${hint}: ${reason}`, { timeoutMs: 6_000 })
      }
    } catch (err) {
      const msg = String((err as { message?: unknown })?.message ?? err)
      $.ui.toast(`history: pane open failed: ${msg}`, { timeoutMs: 4_000 })
    }
    $.ui.invalidate('ui.render')
  }

  return $el.Box({
    flexDirection: 'row',
    gap: 2,
    paddingX: 1,
    children: [
      $el.Text({
        color: 'magenta',
        bold: true,
        children: `▶ History: ${c.user} user, ${c.assistant} assistant, ${c.tools} tool${c.tools === 1 ? '' : 's'}`,
      }),
      $el.Button({
        key: 'open-pane',
        label: 'View',
        hotkey: 'h',
        variant: 'primary',
        onPress: openPane,
      }),
    ],
  })
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    resetState()
    await $.command.register({
      name: COMMAND_NAME,
      description: 'Open / close the conversation log pane',
    })
    return next(e)
  })

  on(
    'classic.SessionStart',
    { source: ['clear', 'resume', 'fork'] },
    async ($, e, next) => {
      resetState()
      return next(e)
    },
  )

  on('command.run', { command: COMMAND_NAME }, async ($) => {
    if (paneOpen) {
      try {
        await $.ui.close({ id: PANE_ID })
        paneOpen = false
        return { text: 'history: closed.' }
      } catch (err) {
        const msg = String((err as { message?: unknown })?.message ?? err)
        return { text: `history: close error: ${msg}` }
      }
    }
    try {
      const r = await $.ui.open({
        id: PANE_ID,
        title: 'Conversation log',
        focus: true,
        closeOnEscape: true,
      })
      paneOpen = r.isPlaced === true
      return r.isPlaced ? { text: 'history: opened.' } : { text: 'history: open refused.' }
    } catch (err) {
      const msg = String((err as { message?: unknown })?.message ?? err)
      return { text: `history: open error: ${msg}` }
    }
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    return renderPane($, e as never) as never
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const $el = resolve($, e as never)
    const ourBand = await renderBand($, e as never)
    if (ourBand === null) {
      return (await next(e)) as never
    }
    let others: unknown = null
    try {
      others = await next(e)
    } catch {
      others = null
    }
    const looksLikeElement =
      others !== null &&
      others !== undefined &&
      typeof others === 'object' &&
      typeof (others as { type?: unknown }).type === 'string'
    if (!looksLikeElement) return ourBand as never
    return $el.Box({ flexDirection: 'column', children: [others, ourBand] }) as never
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE_ID) {
      paneOpen = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })
}
