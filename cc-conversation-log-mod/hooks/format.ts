// Pure formatting helpers for cc-conversation-log-mod.
//
// Everything here is engine-independent: no `$.` imports, no DOM, no Node.
// `hooks/register.tsx` calls into these from render; `tests/format.test.ts`
// drives them directly.
//
// Inputs are plain SessionMessage shapes from `$.session.messages()`:
//   { role: 'user' | 'assistant', text: string, toolUses?, toolResults? }
//
// Output is plain strings / small shapes the renderer turns into Box / Text /
// Code elements. Keeping the format layer engine-free is what lets the Pane
// render with the right truncation without touching the JSX tree.

// ---------------------------------------------------------------------------
// Page-size constants — also surfaced via the plugin's main constants block.
// ---------------------------------------------------------------------------

/** Per-page window when paging older messages into view. */
export const PAGE_SIZE = 50

/** Hard cap on a single text field a row draws. Beyond this we truncate
 * with a trailing marker so a 50kb tool result can't blow up the Pane. */
export const MAX_TEXT_CHARS = 4_000

/** Same, but for the inline summary we show on each tool row before
 * expanding — too long defeats the "▶ N tools" glance. */
export const MAX_PREVIEW_CHARS = 200

/** When an Assistant message has zero text and only tool calls, we still
 * want a non-empty body for the row; this placeholder prevents an
 * awkward blank line. */
export const ASSISTANT_NO_TEXT = '(no prose)'

// ---------------------------------------------------------------------------
// Text truncation
// ---------------------------------------------------------------------------

/**
 * Slice `text` to at most `max` characters, cutting on a boundary that
 * keeps the last full line if possible. Trailing marker shows the real
 * length the user is missing. Empty / undefined input returns ''.
 *
 * Why we don't just `.slice(0, max)`: mid-line cuts land on a tool name
 * and read as a fresh typo. Cutting on the last newline before `max` keeps
 * the row readable. Long single-line strings still get cut mid-line —
 * acceptable; the marker tells the user.
 */
export function truncateText(text: string | undefined, max: number): string {
  if (!text) return ''
  if (text.length <= max) return text
  // Find the last newline at or before `max` that would not leave a useless
  // tail of whitespace. Failing that, cut at `max` regardless.
  const cut = findLastNewline(text, max)
  const head = cut > 0 ? text.slice(0, cut) : text.slice(0, max)
  const dropped = text.length - head.length
  return `${head}\n…(+${dropped} chars)`
}

/** Last `\n` at index `<= max` and `> 0`. `-1` if none / cut at max. */
function findLastNewline(text: string, max: number): number {
  // `text.lastIndexOf('\n', max - 1)` would search BEFORE position max; we
  // want AT OR BEFORE. The string API searches the position too, so pass
  // `max` (last index is inclusive in lastIndexOf semantics).
  for (let i = max; i > 0; i--) {
    if (text.charCodeAt(i) === 10) return i
  }
  return -1
}

// ---------------------------------------------------------------------------
// Tool-call summaries
// ---------------------------------------------------------------------------

/** One label per known built-in tool. MCP tools fall back to the tool's
 * own name. Keep this map small — it's the per-row tagline, not a docs
 * site. New entries go behind tests/format.test.ts. */
const TOOL_ICON: Record<string, string> = {
  Read: '📖',
  Edit: '✏️',
  Write: '📝',
  Bash: '🖥 ',
  Glob: '🔎',
  Grep: '🔍',
  WebFetch: '🌐',
  WebSearch: '🔍',
  Task: '🤖',
  Agent: '🤖',
  TodoWrite: '☑',
  NotebookEdit: '📓',
}

const TOOL_GLYPH = (tool: string): string => TOOL_ICON[tool] ?? '⚙'

/**
 * "Bash: ls -la" or "Read: foo.txt" — one-liner describing what the model
 * asked each tool to do. Truncated to `MAX_PREVIEW_CHARS` so a long Bash
 * command doesn't dominate the row before the user expands it.
 *
 * The label extractor is best-effort: tools it doesn't recognise use
 * `JSON.stringify(input)` as the user-informative fallback. Empty input →
 * empty label (tool name alone reads cleaner than `: {}`).
 */
export function toolLabel(
  tool: string,
  input: Record<string, unknown>,
): string {
  const value = primaryArg(tool, input)
  if (!value) return tool
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  return `${tool}: ${truncateInline(text, MAX_PREVIEW_CHARS)}`
}

/**
 * Just the icon — `'📖'`, `'🖥 '`, `'🤖'`, `'⚙'`. Used at the head of each
 * collapsed tool row so the eye scans by colour.
 */
export function toolIcon(tool: string): string {
  return TOOL_GLYPH(tool)
}

/** Best single argument for each known tool. Falls back to the first
 * string-typed input field; then to `JSON.stringify(input)`; then to
 * `undefined` when input is empty. */
function primaryArg(
  tool: string,
  input: Record<string, unknown>,
): unknown {
  if (!input || typeof input !== 'object') return undefined
  switch (tool) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return pickString(input, 'file_path') ?? pickString(input, 'notebook_path')
    case 'Bash':
      return pickString(input, 'command') ?? pickString(input, 'description')
    case 'Glob':
      return pickString(input, 'pattern')
    case 'Grep':
      return pickString(input, 'pattern')
    case 'WebFetch':
      return pickString(input, 'url')
    case 'WebSearch':
      return pickString(input, 'query')
    case 'Agent':
    case 'Task':
      return pickString(input, 'description') ?? pickString(input, 'prompt')
    default:
      // Generic MCP tool: pick the first string-typed arg we see.
      for (const k of Object.keys(input)) {
        const v = input[k]
        if (typeof v === 'string' && v.length > 0) return v
      }
      return undefined
  }
}

function pickString(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key]
  return typeof v === 'string' ? v : undefined
}

/** Inline truncation suitable for a label (no leading indent, no marker —
 * the marker would push the row off-screen when chained). Plain ellipsis. */
function truncateInline(text: string, max: number): string {
  if (text.length <= max) return text
  return text.slice(0, Math.max(1, max - 1)) + '…'
}

// ---------------------------------------------------------------------------
// Tool-result summaries (collapsed view)
// ---------------------------------------------------------------------------

/**
 * "→ ok · 412 chars" / "→ error · 12 lines" / "→ (running)" / "→ no result".
 * Used to give the collapsed tool row an outcome colour without forcing the
 * user to expand.
 */
export function toolResultSummary(
  text: string | undefined,
  isError: boolean | undefined,
  hasResult: boolean,
): string {
  if (!hasResult) return '⏳ in flight'
  if (isError) return '✗ error'
  const len = text?.length ?? 0
  if (len === 0) return '✓ empty'
  if (len <= 60) return `✓ ${text.replace(/\s+/g, ' ').trim()}`
  const lines = (text.match(/\n/g)?.length ?? -1) + 1
  return `✓ ${len} chars · ${lines} line${lines === 1 ? '' : 's'}`
}

/** A compact representation of a tool result's first line / first 60 chars
 * — shown when the user expands the tool row but we don't want to dump
 * 50kb into a `Code { format: 'text' }` block. */
export function toolResultHead(text: string | undefined, max = 200): string {
  if (!text) return ''
  const first = text.split('\n', 1)[0] ?? ''
  return truncateInline(first, max)
}

// ---------------------------------------------------------------------------
// Role / icon / colour helpers
// ---------------------------------------------------------------------------

/** '👤' for user, '🤖' for assistant — the row header glyph. */
export function roleIcon(role: 'user' | 'assistant'): string {
  return role === 'user' ? '👤' : '🤖'
}

/** 'cyan' for user (matches transcript default), 'magenta' for assistant. */
export function roleColor(role: 'user' | 'assistant'): string {
  return role === 'user' ? 'cyan' : 'magenta'
}

// ---------------------------------------------------------------------------
// Counting — band + header summary
// ---------------------------------------------------------------------------

export type MessageCounts = {
  user: number
  assistant: number
  tools: number
  total: number
}

/** Sum what the band / header needs in one pass. */
export function countMessages(
  messages: ReadonlyArray<{ role: 'user' | 'assistant'; toolUses?: unknown[] }>,
): MessageCounts {
  let user = 0
  let assistant = 0
  let tools = 0
  for (const m of messages) {
    if (m.role === 'user') user++
    else if (m.role === 'assistant') assistant++
    if (Array.isArray(m.toolUses)) tools += m.toolUses.length
  }
  return { user, assistant, tools, total: messages.length }
}

/**
 * Subset of `messages` to render — the NEWEST `window` entries. Older
 * entries are dropped until the user clicks `[ Load earlier ]`.
 *
 * Callers pass `windowSize` (the current page width) and grow it on each
 * press of the load-earlier button until it reaches `messages.length`.
 * Returning a NEW array (slice) instead of an index range is friendlier
 * to the renderer's `messages.map(...)` and avoids an off-by-one when
 * `windowSize > messages.length`.
 */
export function pageLatest<T>(
  messages: readonly T[],
  windowSize: number,
): T[] {
  if (windowSize >= messages.length) return messages.slice()
  const start = Math.max(0, messages.length - windowSize)
  return messages.slice(start)
}

/**
 * How many older messages a `[ Load earlier ]` button at the top of the
 * pane would add right now. Used both for the button label
 * ("Load 50 earlier · 187 more older") and to disable the button at the
 * very top of the transcript.
 */
export function earlierCount(
  totalMessages: number,
  windowSize: number,
): number {
  if (windowSize >= totalMessages) return 0
  return Math.min(PAGE_SIZE, totalMessages - windowSize)
}

// ---------------------------------------------------------------------------
// Timestamp formatting — the transcript stores no per-message wall-clock,
// so we approximate from the message index (the order the engine wrote
// them). Use a relative index suffix as a stable label.
//
// The "HH:MM" wall clock used by cc-file-history-mod is fine there because
// `tool.call` carries a wall clock; SessionMessage does not. Falling back
// to a position label keeps something visible in the row header that's at
// least monotonic.
// ---------------------------------------------------------------------------

/** "1st", "2nd", "3rd", "4th", ...; "11th"/"12th"/"13th" included. */
export function ordinal(n: number): string {
  const abs = Math.abs(Math.trunc(n))
  const lastTwo = abs % 100
  if (lastTwo >= 11 && lastTwo <= 13) return `${abs}th`
  switch (abs % 10) {
    case 1: return `${abs}st`
    case 2: return `${abs}nd`
    case 3: return `${abs}rd`
    default: return `${abs}th`
  }
}
