// cc-timing-mod — shows where a turn's wall-clock time actually went.
//
// Claude Code can sit and work for minutes. The transcript says *what* it
// did; it never says *why it took so long*. This mod measures the turn and
// splits its time into the buckets that explain a slow turn:
//
//   model     — the model requests (time to first token + generation)
//   tools     — the tool calls the engine ran (parallel calls counted once)
//   approval  — the time YOU spent approving a tool call
//   hooks     — what other plugins' hooks added (a breakdown, not a bucket)
//   other     — the engine's own overhead between the model and the tools
//
// Two surfaces:
//
//   AbovePrompt band — a live one-line summary of the running turn (and of
//   the last turn once it ends), with a [View] button. This is the
//   answer to "why is it taking so long" without leaving the prompt.
//
//   Pane — opened with /timing or the band's button. One block per turn,
//   newest first: the buckets, then (expanded) every model request with its
//   time-to-first-token and token counts, and every tool call with its
//   execution time and approval wait.
//
// How the numbers are measured:
//
//   model   — `turn.step` wraps the engine's model request: the clock runs
//             from the request going out to the response's last chunk, and
//             the time to the first chunk is the time to first token.
//   tools   — `tool.call` wraps each call's dispatch, from the call to its
//             result.
//   hooks   — `next.trace` after the dispatch settles: one entry per link
//             in the chain beneath ours, each with its own wall time. The
//             engine's own entry is the tool's execution; every other
//             entry is a plugin's hook, and we add those up per plugin.
//   approval — `classic.PermissionRequest` marks when the prompt was
//             raised, `classic.PreToolUse` / `classic.PostToolUse` mark
//             when the approved call got to run. The gap is the wait.
//
// State lives in `$.state` (the session's own store), so a hot reload of
// this mod keeps the timeline.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { StepRecord, ToolRecord, TurnRecord } from '../types'
import {
  MAX_STEPS,
  MAX_TOOLS,
  MAX_TURNS,
  capList,
  formatClock,
  formatDuration,
  formatTokens,
  summarize,
  summarizeLabel,
  waitMsOf,
} from './timing'

// ---------------------------------------------------------------------------
// Constants & state
// ---------------------------------------------------------------------------

/** Engine Pane id; must be 1-64 chars of letters/digits/`_`/`-`. */
const PANE_ID = 'cc-timing-mod-pane'

/** Slash command shown in the engine's command list. */
const COMMAND_NAME = 'timing'

/** The session's turns. `$.state` holds them; this is the address. */
const turnsAtom = atom({ plugin: 'cc-timing-mod', key: 'turns' } as const, [])

/** Mirror of the engine's own Pane placement, so the band can step aside. */
let paneOpen = false

/** Which turn each loop is running right now, by loop key. */
const currentTurnByLoop = new Map<string, string>()

/** How many turns are in flight (main loop + subagents). Drives the ticker. */
let runningTurns = 0

/**
 * Approval prompts the engine raised and nobody answered yet, oldest first.
 * A `classic.PermissionRequest` pushes one; the tool call it belongs to
 * takes it.
 */
const pendingPerms: { at: number; tool: string }[] = []

/**
 * Approval waits resolved before the tool call's own dispatch started
 * (the engine asks for permission before it dispatches the call). Keyed by
 * the call's `tool_use_id`.
 */
const waitByToolUseId = new Map<string, { startMs: number; endMs: number }>()

/**
 * The tool's own execution time, as `classic.PostToolUse` reports it.
 *
 * That event fires INSIDE the tool call's dispatch — before the dispatch
 * returns and the call's record exists — so the number is parked here and
 * picked up when the record is built.
 */
const execByToolUseId = new Map<string, { execMs: number | null; at: number }>()

/** Which turns the Pane shows expanded. */
const expandedTurns = new Set<string>()

// ---------------------------------------------------------------------------
// Element type — narrow alias to keep the JSX tree short.
// ---------------------------------------------------------------------------

type El = (props: Record<string, unknown> & { children?: unknown }) => unknown
type Elements = {
  Box: El
  Text: El
  Button: El
}

function resolve($: EngineInterface, e: { surface: string }): Elements {
  return $.ui.resolve(e as never) as unknown as Elements
}

/** The loop a turn or a tool call belongs to: the main loop, or a subagent. */
function loopKey(agentId?: string): string {
  return agentId ?? 'main'
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Rewrites one turn, leaving the rest alone. A turn that is gone is skipped.
 *
 * Every failure here is swallowed: this mod watches the session, it must
 * never break it. A dropped measurement is a smaller price than a tool call
 * that fails because a number could not be written.
 */
async function patchTurn(
  $: EngineInterface,
  turnId: string,
  change: (turn: TurnRecord) => TurnRecord,
): Promise<void> {
  try {
    await update($, turnsAtom, (turns) => {
      let hit = false
      const next = turns.map((t) => {
        if (t.turnId !== turnId) return t
        hit = true
        return change(t)
      })
      return hit ? next : turns
    })
  } catch {
    /* a measurement we could not store */
  }
}

/** Empties the session's timeline. */
async function resetTurns($: EngineInterface): Promise<void> {
  try {
    await update($, turnsAtom, () => [])
  } catch {
    /* nothing to clear */
  }
}

/** The turn a tool call belongs to: the loop's current turn, else the newest. */
function findTurnId(
  $: EngineInterface,
  agentId: string | undefined,
  turns: TurnRecord[],
): string | undefined {
  const mapped = currentTurnByLoop.get(loopKey(agentId))
  if (mapped) return mapped
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t && t.endMs === null && t.agentId === agentId) return t.turnId
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Approval prompts
// ---------------------------------------------------------------------------

/**
 * Takes the oldest unanswered approval prompt for a tool, if there is one.
 * The engine raises the prompt before the call is dispatched, so the wait
 * runs from the prompt to the moment the tool actually starts.
 */
function takePerm(tool: string, notAfterMs: number): { at: number } | undefined {
  for (let i = 0; i < pendingPerms.length; i++) {
    const p = pendingPerms[i]
    if (!p) continue
    if (p.at > notAfterMs) continue
    if (p.tool !== tool) continue
    pendingPerms.splice(i, 1)
    return p
  }
  return undefined
}

/** Keeps the queue short — a prompt nobody answered is not interesting. */
function pushPerm(at: number, tool: string): void {
  pendingPerms.push({ at, tool })
  while (pendingPerms.length > 20) pendingPerms.shift()
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  // A turn slower than this raises a toast naming the buckets. 0 disables.
  const slowTurnSeconds = Number(options.slowTurnSeconds ?? 30)

  // -- session lifecycle ---------------------------------------------------

  on('session.start', async ($, e, next) => {
    currentTurnByLoop.clear()
    pendingPerms.length = 0
    waitByToolUseId.clear()
    execByToolUseId.clear()
    expandedTurns.clear()
    paneOpen = false
    runningTurns = 0
    await resetTurns($)
    await $.command.register({
      name: COMMAND_NAME,
      description: 'Show where each turn\'s time went (model / tools / approval / hooks)',
    })
    // The band shows a running turn's elapsed time, which moves on its own.
    // One invalidate a second is enough for it to tick. A host that cannot
    // give us a timer costs us the ticker, not the mod — so this is
    // guarded: the rest of session.start (the command, the reset) matters
    // more than the tick.
    try {
      $.clock.every(1000, () => {
        if (runningTurns > 0) $.ui.invalidate('ui.render')
      })
    } catch {
      /* no ticker; the band still redraws on every measurement */
    }
    return next(e)
  })

  on(
    'classic.SessionStart',
    { source: ['clear', 'resume', 'fork'] },
    async ($, e, next) => {
      currentTurnByLoop.clear()
      pendingPerms.length = 0
      waitByToolUseId.clear()
      execByToolUseId.clear()
      expandedTurns.clear()
      runningTurns = 0
      await resetTurns($)
      return next(e)
    },
  )

  // -- the turn ------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    const at = Date.now()
    const turn: TurnRecord = {
      turnId: e.turnId,
      agentId: e.agentId,
      label: summarizeLabel(e.text ?? ''),
      startMs: at,
      endMs: null,
      reason: null,
      steps: [],
      tools: [],
      hookMsByPlugin: {},
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    }
    currentTurnByLoop.set(loopKey(e.agentId), e.turnId)
    runningTurns += 1
    try {
      await update($, turnsAtom, (turns) => capList([...turns, turn], MAX_TURNS))
    } catch {
      /* a turn we could not store is a turn we cannot measure */
    }
    return next(e)
  })

  // The model request. This hook is a generator: it wraps the engine's
  // stream, times it, and hands every chunk on untouched.
  on('turn.step', async function* ($, e, next) {
    const startMs = Date.now()
    let ttfbMs = 0
    let chunks = 0
    let endMs = startMs
    let result: {
      toolUses?: readonly unknown[]
      serverToolUses?: readonly { startedAt: number; endedAt?: number }[]
      usage?: {
        input_tokens: number
        output_tokens: number
        cache_read_input_tokens: number
        cache_creation_input_tokens: number
      } | null
    } | undefined

    let failure: unknown
    try {
      const stream = next(e)
      for await (const chunk of stream) {
        if (chunks === 0) ttfbMs = Date.now() - startMs
        chunks += 1
        yield chunk
      }
      endMs = Date.now()
      result = await stream.result
    } catch (err) {
      // A stream cut short (the person interrupted, the API failed) still
      // cost time: record what we know. The failure itself is handed back
      // to the engine below — swallowing it would hide an API error from
      // the turn that has to report it.
      endMs = Date.now()
      failure = err
    }

    const usage = result?.usage ?? null
    const serverToolMs = (result?.serverToolUses ?? []).reduce(
      (sum, u) => sum + Math.max(0, (u.endedAt ?? endMs) - u.startedAt),
      0,
    )
    const step: StepRecord = {
      index: e.index,
      model: e.model,
      startMs,
      endMs,
      ttfbMs,
      toolCallCount: result?.toolUses?.length ?? 0,
      serverToolMs,
      inputTokens: usage?.input_tokens ?? 0,
      outputTokens: usage?.output_tokens ?? 0,
      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
    }

    await patchTurn($, e.turnId, (t) => ({
      ...t,
      steps: capList([...t.steps, step], MAX_STEPS),
      inputTokens: t.inputTokens + step.inputTokens,
      outputTokens: t.outputTokens + step.outputTokens,
      cacheReadTokens: t.cacheReadTokens + step.cacheReadTokens,
      cacheWriteTokens: t.cacheWriteTokens + step.cacheWriteTokens,
    }))

    // The engine's own failure, handed back untouched.
    if (failure) throw failure
  })

  on('turn.complete', async ($, e, next) => {
    const endMs = Date.now()
    await patchTurn($, e.turnId, (t) => ({
      ...t,
      endMs: t.endMs ?? endMs,
      reason: e.reason,
    }))
    currentTurnByLoop.delete(loopKey(e.agentId))
    runningTurns = Math.max(0, runningTurns - 1)

    try {
      const { value: turns } = await $.state.get({
        plugin: 'cc-timing-mod',
        key: 'turns',
      })
      const turn = (turns ?? []).find((t) => t.turnId === e.turnId)
      if (turn && slowTurnSeconds > 0) {
        const s = summarize(turn, endMs)
        if (s.totalMs >= slowTurnSeconds * 1000) {
          $.ui.toast(
            `⏱ turn took ${formatDuration(s.totalMs)} — model ${formatDuration(s.modelMs)}, ` +
              `tools ${formatDuration(s.toolMs)}, approval ${formatDuration(s.approvalMs)}`,
            { timeoutMs: 8000 },
          )
        }
      }
    } catch {
      /* no toast is better than a broken turn */
    }
    return next(e)
  })

  // -- the tool calls ------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    // Nothing but a clock read happens before `next(e)`: the call itself
    // must not wait for a measurement.
    const startMs = Date.now()
    const result = await next(e)
    const endMs = Date.now()

    try {
      const agentId = (e as { agentId?: string }).agentId
      const { value: turns } = await $.state.get({
        plugin: 'cc-timing-mod',
        key: 'turns',
      })
      const turnId = findTurnId($, agentId, turns ?? [])

      // `next.trace` lists what ran beneath us: one entry per link in the
      // chain, each with its own wall time. The engine's own entry is the
      // tool's execution; every other entry is somebody's hook.
      let hookMs = 0
      const hookByPlugin: Record<string, number> = {}
      for (const entry of next.trace) {
        if (entry.plugin === 'engine') continue
        hookMs += entry.ms
        hookByPlugin[entry.plugin] = (hookByPlugin[entry.plugin] ?? 0) + entry.ms
      }

      const isError =
        typeof result === 'object' && result !== null && 'isError' in result
          ? (result as { isError?: boolean }).isError === true
          : false

      // The execution time and the approval wait are measured by the
      // classic hooks, which fire inside this dispatch — before the
      // record exists. Both are parked in maps; pick them up here.
      const exec = execByToolUseId.get(e.tool_use_id)
      let known = waitByToolUseId.get(e.tool_use_id)
      if (!known && exec && exec.execMs !== null) {
        // The prompt may have been raised inside the dispatch too: the
        // execution started at `at - execMs`, so the wait runs from the
        // prompt to there.
        const execStart = exec.at - exec.execMs
        const perm = takePerm(e.tool, execStart)
        if (perm) known = { startMs: perm.at, endMs: execStart }
      }
      const tool: ToolRecord = {
        toolUseId: e.tool_use_id,
        tool: e.tool,
        startMs,
        endMs,
        execMs: exec?.execMs ?? null,
        hookMs,
        waitStartMs: known?.startMs ?? 0,
        waitEndMs: known?.endMs ?? 0,
        isError,
      }
      waitByToolUseId.delete(e.tool_use_id)
      execByToolUseId.delete(e.tool_use_id)

      if (!turnId) return result
      await patchTurn($, turnId, (t) => {
        const merged = { ...t.hookMsByPlugin }
        for (const [name, ms] of Object.entries(hookByPlugin)) {
          merged[name] = (merged[name] ?? 0) + ms
        }
        return {
          ...t,
          tools: capList([...t.tools, tool], MAX_TOOLS),
          hookMsByPlugin: merged,
        }
      })
    } catch {
      /* a measurement we could not take */
    }
    return result
  })

  // -- approvals -----------------------------------------------------------

  on('classic.PermissionRequest', ($, e, next) => {
    pushPerm(Date.now(), e.tool_name)
    return next(e)
  })

  on('classic.PreToolUse', ($, e, next) => {
    const at = Date.now()
    const perm = takePerm(e.tool, at)
    if (perm) {
      waitByToolUseId.set(e.tool_use_id, {
        startMs: perm.at,
        endMs: at,
      })
      // The call's dispatch may already be running (the engine asked for
      // permission inside it) — record the wait on the tool we know about.
      void patchToolWait($, e.tool_use_id, perm.at, at)
    }
    return next(e)
  })

  on('classic.PostToolUse', ($, e, next) => {
    const at = Date.now()
    const execMs = typeof e.duration_ms === 'number' ? e.duration_ms : null
    execByToolUseId.set(e.tool_use_id, { execMs, at })
    void patchToolExec($, e.tool_use_id, execMs)
    return next(e)
  })

  on('classic.PostToolUseFailure', ($, e, next) => {
    const at = Date.now()
    const execMs = typeof e.duration_ms === 'number' ? e.duration_ms : null
    execByToolUseId.set(e.tool_use_id, { execMs, at })
    void patchToolExec($, e.tool_use_id, execMs)
    return next(e)
  })

  // -- the command ---------------------------------------------------------

  on('command.run', { command: COMMAND_NAME }, async ($) => {
    if (paneOpen) {
      try {
        await $.ui.close({ id: PANE_ID })
        paneOpen = false
        return { text: 'timing: closed.' }
      } catch (err) {
        const msg = String((err as { message?: unknown })?.message ?? err)
        return { text: `timing: close error: ${msg}` }
      }
    }
    try {
      const r = await $.ui.open({
        id: PANE_ID,
        title: 'Turn timing',
        focus: true,
        closeOnEscape: true,
      })
      paneOpen = r.isPlaced === true
      return r.isPlaced
        ? { text: 'timing: opened.' }
        : { text: 'timing: open refused.' }
    } catch (err) {
      const msg = String((err as { message?: unknown })?.message ?? err)
      return { text: `timing: open error: ${msg}` }
    }
  })

  // -- the surfaces --------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    return (await renderPane($, e as never)) as never
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
    return $el.Box({
      flexDirection: 'column',
      children: [others, ourBand],
    }) as never
  })

  on('ui.close', ($, e, next) => {
    if (e.id === PANE_ID) {
      paneOpen = false
      $.ui.invalidate('ui.render')
    }
    return next(e)
  })
}

// ---------------------------------------------------------------------------
// Tool-record patches
//
// The approval wait and the pure execution time are measured by the
// classic hooks, which do not necessarily run inside the tool call's own
// dispatch. These two helpers find the call's record in the session's turns
// and write the missing piece.
// ---------------------------------------------------------------------------

async function patchToolWait(
  $: EngineInterface,
  toolUseId: string,
  startMs: number,
  endMs: number,
): Promise<void> {
  try {
    const { value: turns } = await $.state.get({
      plugin: 'cc-timing-mod',
      key: 'turns',
    })
    for (const turn of turns ?? []) {
      if (!turn.tools.some((t) => t.toolUseId === toolUseId)) continue
      await patchTurn($, turn.turnId, (t) => ({
        ...t,
        tools: t.tools.map((tool) =>
          tool.toolUseId === toolUseId
            ? { ...tool, waitStartMs: startMs, waitEndMs: endMs }
            : tool,
        ),
      }))
      return
    }
  } catch {
    /* a wait we could not store */
  }
}

async function patchToolExec(
  $: EngineInterface,
  toolUseId: string,
  execMs: number | null,
): Promise<void> {
  try {
    const { value: turns } = await $.state.get({
      plugin: 'cc-timing-mod',
      key: 'turns',
    })
    for (const turn of turns ?? []) {
      if (!turn.tools.some((t) => t.toolUseId === toolUseId)) continue
      await patchTurn($, turn.turnId, (t) => ({
        ...t,
        tools: t.tools.map((one) =>
          one.toolUseId === toolUseId ? { ...one, execMs } : one,
        ),
      }))
      return
    }
  } catch {
    /* an execution time we could not store */
  }
}

// ---------------------------------------------------------------------------
// Pane render
// ---------------------------------------------------------------------------

async function renderPane($: EngineInterface, e: { surface: string }): Promise<unknown> {
  const $el = resolve($, e)
  const turns = await read($, turnsAtom)
  const now = Date.now()

  const closePane = async (): Promise<void> => {
    paneOpen = false
    await $.ui.close({ id: PANE_ID })
  }
  const clearAll = async (): Promise<void> => {
    await update($, turnsAtom, () => [])
    $.ui.invalidate('ui.render')
  }

  const header = $el.Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      $el.Text({ children: '⏱' }),
      $el.Text({ bold: true, color: 'magenta', children: 'Turn timing' }),
      $el.Text({
        dimColor: true,
        children: `${turns.length} turn${turns.length === 1 ? '' : 's'}`,
      }),
      $el.Box({ flexGrow: 1 }),
      $el.Button({
        key: 'clear',
        label: 'Clear',
        plain: true,
        dimColor: true,
        onPress: clearAll,
      }),
      $el.Button({
        key: 'close',
        label: 'Close',
        variant: 'primary',
        onPress: closePane,
      }),
    ],
  })

  if (turns.length === 0) {
    return $el.Box({
      flexDirection: 'column',
      paddingX: 1,
      gap: 1,
      children: [
        header,
        $el.Text({ dimColor: true, children: 'no turns measured yet — send a prompt first.' }),
      ],
    })
  }

  const rows: unknown[] = []
  // Newest first: the turn you just ran is the one you are asking about.
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]
    if (!turn) continue
    rows.push(renderTurnRow($, $el, turn, turns.length - i, now))
  }

  return $el.Box({
    flexDirection: 'column',
    paddingX: 1,
    gap: 1,
    children: [header, ...rows],
  })
}

/** One turn's block: the summary, and — expanded — the requests and calls. */
function renderTurnRow(
  $: EngineInterface,
  $el: Elements,
  turn: TurnRecord,
  ordinal: number,
  now: number,
): unknown {
  const s = summarize(turn, now)
  const isOpen = expandedTurns.has(turn.turnId)
  const running = turn.endMs === null

  const toggle = (): void => {
    if (expandedTurns.has(turn.turnId)) expandedTurns.delete(turn.turnId)
    else expandedTurns.add(turn.turnId)
    $.ui.invalidate('ui.render')
  }

  const title = $el.Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      $el.Text({ children: isOpen ? '▼' : '▶' }),
      $el.Text({ bold: true, children: `#${ordinal}` }),
      $el.Text({ bold: true, color: running ? 'yellow' : 'green', children: formatDuration(s.totalMs) }),
      $el.Text({ dimColor: true, children: formatClock(turn.startMs) }),
      ...(turn.agentId
        ? [$el.Text({ dimColor: true, children: `agent ${turn.agentId}` })]
        : []),
      $el.Text({ dimColor: true, children: turn.label }),
      $el.Box({ flexGrow: 1 }),
      $el.Button({
        key: `toggle-${turn.turnId}`,
        label: isOpen ? 'Hide' : 'Details',
        plain: true,
        dimColor: true,
        onPress: toggle,
      }),
    ],
  })

  // The buckets. `approval` and `hooks` only appear when they cost
  // something — a row of zeroes is noise.
  const bucket = (label: string, value: string, note?: string): unknown =>
    $el.Box({
      flexDirection: 'row',
      gap: 1,
      paddingLeft: 2,
      children: [
        $el.Text({ dimColor: true, children: label.padEnd(9, ' ') }),
        $el.Text({ children: value }),
        ...(note ? [$el.Text({ dimColor: true, children: note })] : []),
      ],
    })

  const toolNote =
    s.toolCount === 0
      ? ''
      : `${s.toolCount} call${s.toolCount === 1 ? '' : 's'}` +
        (s.toolExecMs > 0 ? ` · exec ${formatDuration(s.toolExecMs)}` : '') +
        (s.toolOverheadMs > 500 ? ` · ${formatDuration(s.toolOverheadMs)} overhead` : '')

  const buckets: unknown[] = [
    bucket('model', formatDuration(s.modelMs), `${s.requestCount} request${s.requestCount === 1 ? '' : 's'}`),
    bucket('tools', formatDuration(s.toolMs), toolNote),
  ]
  if (s.approvalMs > 0) {
    buckets.push(bucket('approval', formatDuration(s.approvalMs), 'waiting for you'))
  }
  if (s.hookMs > 0) {
    buckets.push(
      bucket(
        'hooks',
        formatDuration(s.hookMs),
        s.topHooks.map((h) => `${h.name} ${formatDuration(h.ms)}`).join(' · '),
      ),
    )
  }
  if (s.otherMs > 0) {
    buckets.push(bucket('other', formatDuration(s.otherMs), 'engine overhead'))
  }
  buckets.push(
    bucket(
      'tokens',
      `in ${formatTokens(s.inputTokens)}`,
      `out ${formatTokens(s.outputTokens)} · cached ${formatTokens(s.cacheReadTokens)}` +
        (s.cacheWriteTokens > 0 ? ` · written ${formatTokens(s.cacheWriteTokens)}` : ''),
    ),
  )

  if (!isOpen) {
    return $el.Box({
      flexDirection: 'column',
      gap: 0,
      children: [title, ...buckets],
    })
  }

  // Expanded: every model request, then every tool call.
  const details: unknown[] = []

  if (turn.steps.length > 0) {
    details.push($el.Text({ dimColor: true, bold: true, children: 'requests' }))
    for (const step of turn.steps) {
      details.push(
        $el.Box({
          flexDirection: 'row',
          gap: 1,
          paddingLeft: 4,
          children: [
            $el.Text({ children: `#${step.index}` }),
            $el.Text({ children: formatDuration(step.endMs - step.startMs) }),
            $el.Text({ dimColor: true, children: `ttfb ${formatDuration(step.ttfbMs)}` }),
            $el.Text({ dimColor: true, children: step.model }),
            $el.Text({
              dimColor: true,
              children:
                `in ${formatTokens(step.inputTokens)} · out ${formatTokens(step.outputTokens)}` +
                (step.toolCallCount > 0 ? ` · ${step.toolCallCount} tool call(s)` : ''),
            }),
          ],
        }),
      )
    }
  }

  if (turn.tools.length > 0) {
    details.push($el.Text({ dimColor: true, bold: true, children: 'tool calls' }))
    for (const tool of turn.tools) {
      const wait = waitMsOf(tool)
      details.push(
        $el.Box({
          flexDirection: 'row',
          gap: 1,
          paddingLeft: 4,
          children: [
            $el.Text({ children: tool.tool }),
            $el.Text({ children: formatDuration(tool.endMs - tool.startMs) }),
            ...(tool.execMs !== null
              ? [$el.Text({ dimColor: true, children: `exec ${formatDuration(tool.execMs)}` })]
              : []),
            ...(wait > 0
              ? [$el.Text({ dimColor: true, color: 'yellow', children: `approval ${formatDuration(wait)}` })]
              : []),
            ...(tool.hookMs > 0
              ? [$el.Text({ dimColor: true, children: `hooks ${formatDuration(tool.hookMs)}` })]
              : []),
            ...(tool.isError ? [$el.Text({ color: 'red', children: 'error' })] : []),
          ],
        }),
      )
    }
  }

  return $el.Box({
    flexDirection: 'column',
    gap: 0,
    children: [title, ...buckets, ...details],
  })
}

// ---------------------------------------------------------------------------
// AbovePrompt band — one live line about the running turn.
//
// The shape follows the other bands (cc-file-history-mod, cc-conversation-log-mod):
// a `▶` marker, the mod's name and its figures in one magenta line, and a
// button to open the Pane. The hotkey is `t` — the other bands hold `v` and `h`.
// ---------------------------------------------------------------------------

async function renderBand($: EngineInterface, e: { surface: string }): Promise<unknown | null> {
  const $el = resolve($, e)
  const turns = await read($, turnsAtom)
  if (turns.length === 0) return null
  // The Pane's own header says the same thing; two copies of it is noise.
  if (paneOpen) return null

  const now = Date.now()
  // The running turn if there is one, else the last one that finished.
  let turn: TurnRecord | undefined
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i]
    if (t && t.endMs === null) {
      turn = t
      break
    }
  }
  if (!turn) turn = turns[turns.length - 1]
  if (!turn) return null

  const s = summarize(turn, now)
  const running = turn.endMs === null

  const parts: string[] = [formatDuration(s.totalMs)]
  parts.push(`model ${formatDuration(s.modelMs)}`)
  parts.push(`tools ${formatDuration(s.toolMs)}`)
  if (s.approvalMs > 0) parts.push(`approval ${formatDuration(s.approvalMs)}`)
  if (s.hookMs > 0) parts.push(`hooks ${formatDuration(s.hookMs)}`)
  if (!running && s.otherMs > 0) parts.push(`other ${formatDuration(s.otherMs)}`)

  const openPane = async (): Promise<void> => {
    try {
      const r = await $.ui.open({
        id: PANE_ID,
        title: 'Turn timing',
        focus: true,
        closeOnEscape: true,
      })
      paneOpen = r.isPlaced === true
      if (!r.isPlaced) {
        const reason = 'reason' in r ? String(r.reason) : 'unknown'
        const hint = reason.includes('below 110 columns') ? ' — type /timing once to unlock' : ''
        $.ui.toast(`timing: pane open refused${hint}: ${reason}`, { timeoutMs: 6000 })
      }
    } catch (err) {
      const msg = String((err as { message?: unknown })?.message ?? err)
      $.ui.toast(`timing: pane open failed: ${msg}`, { timeoutMs: 4000 })
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
        children: `▶ Timing: ${running ? 'turn' : 'last turn'} ${parts.join(' · ')}`,
      }),
      $el.Button({
        key: 'open-pane',
        label: 'View',
        hotkey: 't',
        variant: 'primary',
        onPress: openPane,
      }),
    ],
  })
}
