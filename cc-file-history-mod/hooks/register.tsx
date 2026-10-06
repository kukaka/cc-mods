// cc-file-history-mod
//
// Captures every Edit / Write Claude issues this session and lets the user
// revert any one of them. Single surface:
//
//   Pane — opened on demand by /file-history. Has the engine's dark chrome
//   (a fixed engine choice, not plugin-controllable), so on a light terminal
//   it looks wrong; we open it explicitly only when the user actually wants
//   to look at the full list or revert.
//
// Slash command: /file-history — open / close the Pane.
//
// State is module-local. A session.start, classic.SessionStart
// { clear|resume|fork }, or hot reload resets it. `paneOpen` is best-effort:
// if they close via the engine's X / Esc, our local flag lags until the next
// /file-history, at which point the toggle fights itself for one round.

import type { EngineInterface, Register } from 'claude-code'

import {
  basename,
  cap,
  formatTime,
  groupByFile,
  type EditKind,
  type EditRecord,
} from './history'

// ---------------------------------------------------------------------------
// State — all module-local (resets on hot reload).
// ---------------------------------------------------------------------------

let edits: EditRecord[] = []
let nextId = 1
let paneOpen = false
// Which edit rows the user has opened in the Pane, and the diff text we
// already computed for them. The diff cache keeps `diff -u` from running
// every time the Pane redraws.
const expanded = new Set<number>()
const diffCache = new Map<number, string | null>()

// Pane id must be 1-64 of letters, digits, `_` or `-` (host check).
const PANE_ID = 'cc-file-history-mod-pane'

function resetState() {
  edits = []
  nextId = 1
  paneOpen = false
  expanded.clear()
  diffCache.clear()
}

// ---------------------------------------------------------------------------
// Snapshot / record helper (shared by Edit and Write hooks).
// ---------------------------------------------------------------------------

type FileEditInput = {
  tool_use_id: string
  file_path: string
}

/** Edit-tool input carries the diff hunk directly. */
type EditToolInput = FileEditInput & {
  old_string: string
  new_string: string
  replace_all?: boolean
}

/** Write-tool input carries the new content; the old content we have to read. */
type WriteToolInput = FileEditInput & {
  content: string
}

/** Bash-tool input — just the command line and an optional timeout. */
type BashToolInput = {
  tool_use_id: string
  command: string
  timeout?: number
}

/** Subset of BashResult we actually consume (`bashEditDiff` only). */
type BashResultShape = {
  bashEditDiff?: {
    files?: {
      filePath: string
      created?: true
      deleted?: true
    }[]
    unavailable?: true
    skipped?: true
  }
}

type NextResult = {
  result?: unknown
  isError?: boolean
  deny?: unknown
}

async function recordTool<E extends FileEditInput>(
  $: EngineInterface,
  e: E,
  kind: EditKind,
  next: (e: E) => Promise<NextResult>,
) {
  // Snapshot strategy differs by tool:
  //   Edit  — `old_string` / `new_string` come in `e`; we don't read the
  //           file at all. The hunk is enough for the diff display, and
  //           Revert does a `new_string → old_string` find-and-replace on
  //           the current file at Revert time (one read, deferred).
  //   Write — input has the new `content`, but no old content. We `$.fs.read`
  //           before the tool runs for `before` (used by Revert and by the
  //           full-file diff). For `after` we use `content` directly — no
  //           second read.
  let before: string | undefined
  let beforeExists = true
  let hunkBefore: string | undefined
  let hunkAfter: string | undefined
  if (kind === 'write') {
    try {
      before = await $.fs.read(e.file_path)
    } catch {
      before = undefined
      beforeExists = false
    }
  } else {
    const editE = e as unknown as EditToolInput
    hunkBefore = editE.old_string
    hunkAfter = editE.new_string
  }

  const result = await next(e)

  // Drop denied / errored calls — we don't want a Revert button on them.
  if (!result || result.isError || result.deny) return result

  // Canonicalise the path so two spellings of the same file collapse into
  // one group in the panel (macOS case aliases, ./ etc.).
  let resolved = e.file_path
  try {
    const s = await $.fs.stat(e.file_path, { resolve: true })
    if (s && typeof s.realPath === 'string' && s.realPath.length > 0) {
      resolved = s.realPath
    }
  } catch {
    /* keep original */
  }

  // For Write, the input's `content` IS the post-write file. For Edit, we
  // don't track a full `after`; the hunk is enough for the diff display.
  let after: string | undefined
  if (kind === 'write') {
    after = (e as unknown as WriteToolInput).content
  }

  edits = cap<EditRecord>(
    [
      ...edits,
      {
        id: nextId++,
        filePath: resolved,
        kind,
        toolUseId: e.tool_use_id,
        ts: Date.now(),
        beforeExists,
        before,
        after,
        hunkBefore,
        hunkAfter,
        applied: true,
      },
    ],
    200,
  )
  // First edit of a session auto-opens the Pane — the user clearly wants
  // visibility into what just happened. `$.ui.open` is idempotent and safe
  // against a Pane the user has already manually opened or focused on
  // another surface; `paneOpen` may be stale (X / Esc close paths bypass
  // our local flag) but we don't gate on it — the cost of one extra
  // open call is a small toast at worst. Subsequent edits leave the Pane
  // alone, so a manual close sticks for the rest of the session.
  //
  // Defensive: `$.ui.open` may throw or return `{ isPlaced: false }` from
  // a tool.call context. Some specific refusal reasons the engine gives:
//   - "below 110 columns … an id the person opened before": a plugin-
  //     initiated open counts as "unasked" on narrow terminals; the pane
  //     will only draw after the user has explicitly /file-history'd at
  //     least once (which marks it as person-opened). Tell the user so.
  //   - other surfaces / contexts the engine won't place a pane from.
  // Either case must NOT make the edit itself fail — the file is already
  // written by `next(e)`, we just couldn't pop a Pane.
  if (edits.length === 1) {
    try {
      const r = await $.ui.open({
        id: PANE_ID,
        title: 'File history',
        focus: true,
        closeOnEscape: true,
      })
      paneOpen = r.isPlaced === true
      if (!r.isPlaced) {
        const reason = 'reason' in r ? String(r.reason) : 'unknown'
        const hint = reason.includes('below 110 columns')
          ? ' — type /file-history once to unlock'
          : ''
        $.ui.toast(
          `file-history auto-open refused${hint}: ${reason}`,
          { timeoutMs: 6000 },
        )
      }
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err)
      $.ui.toast(`file-history auto-open failed: ${msg}`, { timeoutMs: 4000 })
    }
  }
  $.ui.invalidate('ui.render')
  return result
}

// ---------------------------------------------------------------------------
// Bash tool — record file deletions.
//
// Strategy:
//     1. parse `rm` / `unlink` / `rmdir` paths out of `command` so we know
//        which files to `$.fs.read` BEFORE Bash runs (Revert needs the
//        content; once Bash is done the file is gone).
//     2. run `next(e)` to let Bash execute.
//     3. read `result.bashEditDiff` for the engine's authoritative list of
//        files actually deleted/created/modified by the command. This
//        catches paths our parser missed (globs the shell expanded,
//        shell variables, `mv a /dev/null`, `find -delete`, etc.).
//     4. union of parse-read files + bashEditDiff-deleted files = what we
//        record. Files we couldn't read (globs, vars we didn't expand,
//        shell-built-in deletes) are skipped — they'd have no content
//        for Revert anyway.
//
// Known limitations:
//   - Globs in the command: parse sees the literal `*.txt`, can't read
//     it. bashEditDiff lists the expanded paths, but we have no content.
//     To support globs we'd have to walk the cwd and expand before Bash
//     runs; deferred for now.
//   - Variable expansion (`rm $FOO`): same — the engine sees the
//     expanded form, but we'd need to know the variable.
//   - The diff-side fallback (reading `-`-prefixed lines from
//     bashEditDiff's hunks) is NOT implemented — for pure `rm` of a file
//     bashEditDiff would have all lines as `-`, but partial edits
//     (sed, etc.) wouldn't. Out of scope; the union approach covers the
//     common patterns.
// ---------------------------------------------------------------------------

/** Tokenise a shell-style command on whitespace, respecting "..." and '...'. */
function tokenizeCommand(command: string): string[] {
  // Match runs of non-whitespace/non-quote, or quoted strings.
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? []
}

function stripQuote(s: string): string {
  return s.replace(/^['"]|['"]$/g, '')
}

/** Strip flags from an rm command and return the literal-path candidates. */
function parseRmCandidates(command: string): string[] {
  const tokens = tokenizeCommand(command)
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const head = stripQuote(tokens[i])
    if (head !== 'rm' && head !== 'unlink' && head !== 'rmdir') continue
    // After `rm`, walk args. Flags (-r, -rf, -i, --) are skipped; `--`
    // ends option parsing; everything else is a candidate path.
    for (i = i + 1; i < tokens.length; i++) {
      const t = stripQuote(tokens[i])
      if (t === '--') break
      if (t.startsWith('-')) continue
      out.push(t)
    }
  }
  return out
}

async function recordBash(
  $: EngineInterface,
  e: BashToolInput,
  next: (e: BashToolInput) => Promise<NextResult>,
) {
  // Pre-snapshot content for every parse candidate so we have it if Bash
  // actually deletes one of them. Read failures (file doesn't exist, perms)
  // are silent — we only care about files we successfully captured.
  const candidates = parseRmCandidates(e.command)
  const preContent = new Map<string, string>()
  for (const p of candidates) {
    try {
      const content = await $.fs.read(p)
      preContent.set(p, content)
    } catch {
      /* not a regular file, or didn't exist; nothing to revert */
    }
  }

  const result = await next(e)

  // Drop denied / errored calls.
  if (!result || result.isError || result.deny) return result

  // Two paths to the deletion set:
//
//   1. Engine-reported: `result.result.bashEditDiff.files[].deleted: true`.
//      Captures delete paths our parse can't see (`mv a /dev/null`,
//      `find -delete`, shell-internal deletes), but in practice (this
//      build) the engine does NOT populate bashEditDiff for plain `rm` —
//      we get files=[] or no field at all. Treat it as bonus.
//
//   2. Stat probe: for every candidate we pre-read, `$.fs.stat` after
//      `next(e)`. If the path now errors, Bash deleted it. This is what
//      actually catches `rm path` in this build; the engine layer is a
//      no-op in the common case.
//
// We don't change Parse-side handling for Bash edits (sed, awk, etc.):
// those land in bashEditDiff as `modified` and we deliberately don't
// record them — the Edit/Write hooks own those.
  const bashResult = result as { result?: BashResultShape }
  const bashEditDiff = bashResult.result?.bashEditDiff

  const deletedFromEngine = new Set<string>()
  if (bashEditDiff && !bashEditDiff.unavailable && !bashEditDiff.skipped) {
    for (const f of bashEditDiff.files ?? []) {
      if (f.deleted) deletedFromEngine.add(f.filePath)
    }
  }

  const deletedFromStat = new Set<string>()
  for (const path of preContent.keys()) {
    try {
      await $.fs.stat(path)
      // still exists → not deleted
    } catch {
      deletedFromStat.add(path)
    }
  }

  const deletedPaths = new Set<string>([...deletedFromEngine, ...deletedFromStat])

  if (deletedPaths.size === 0) {
    $.ui.invalidate('ui.render')
    return result
  }

  // Canonicalise every deleted path through the same `$.fs.stat` we use
  // for Edit/Write so two spellings of the same file collapse into one
  // group in the Pane.
  const resolvedByOriginal = new Map<string, string>()
  for (const p of deletedPaths) {
    try {
      const s = await $.fs.stat(p, { resolve: true })
      resolvedByOriginal.set(p, s?.realPath ?? p)
    } catch {
      resolvedByOriginal.set(p, p)
    }
  }

  const newRecords: EditRecord[] = []
  for (const original of deletedPaths) {
    const resolved = resolvedByOriginal.get(original) ?? original
    const content = preContent.get(original)
    // We can only Revert what we captured beforehand; skip files we have
    // no content for (globs the shell expanded, $VAR expansions, etc.).
    if (content === undefined) continue
    newRecords.push({
      id: nextId++,
      filePath: resolved,
      kind: 'delete',
      toolUseId: e.tool_use_id,
      ts: Date.now(),
      beforeExists: true,
      before: content,
      after: undefined,
      applied: true,
    })
  }

  if (newRecords.length > 0) {
    edits = cap<EditRecord>([...edits, ...newRecords], 200)
  }
  $.ui.invalidate('ui.render')
  return result
}

// ---------------------------------------------------------------------------
// Diff helper — produces the unified-diff text for a record and caches it.
//
//   Edit: hunkBefore / hunkAfter come straight from the tool-call input, so
//         we just format them as one unified-diff hunk here. No `$.fs.read`,
//         no `diff -u` shell out — these are tiny (a few lines).
//
//   Write: full before (from `$.fs.read`) vs full after (from the tool
//          input's `content`) — large and arbitrary, so we shell out to
//          GNU `diff -u` like before.
// ---------------------------------------------------------------------------

async function unifiedDiff(
  $: EngineInterface,
  rec: EditRecord,
): Promise<string | null> {
  if (diffCache.has(rec.id)) return diffCache.get(rec.id) ?? null

  if (rec.kind === 'edit') {
    const before = rec.hunkBefore
    const after = rec.hunkAfter
    if (typeof before !== 'string' || typeof after !== 'string') {
      diffCache.set(rec.id, null)
      $.ui.invalidate('ui.render')
      return null
    }
    if (before === after) {
      diffCache.set(rec.id, '')
      $.ui.invalidate('ui.render')
      return ''
    }
    const text = hunkDiffText(before, after)
    diffCache.set(rec.id, text)
    $.ui.invalidate('ui.render')
    return text
  }

  if (rec.kind === 'delete') {
    // No hunk data on a delete record (we only have full `before`); render
    // the deletion as a "removed-everything" diff against /dev/null. Empty
    // file → nothing to show, cache the empty string so we don't redo.
    if (typeof rec.before !== 'string') {
      diffCache.set(rec.id, null)
      $.ui.invalidate('ui.render')
      return null
    }
    if (rec.before.length === 0) {
      diffCache.set(rec.id, '')
      $.ui.invalidate('ui.render')
      return ''
    }
    const lines = rec.before.split('\n')
    if (lines[lines.length - 1] === '') lines.pop()
    const header =
      `--- a/${basename(rec.filePath)}\n` +
      `+++ /dev/null\n` +
      `@@ -1,${lines.length} +0,0 @@`
    const body = lines.map((l) => `-${l}`).join('\n')
    const text = `${header}\n${body}`
    diffCache.set(rec.id, text)
    $.ui.invalidate('ui.render')
    return text
  }

  // Write: shell out `diff -u`. Same as the pre-hunk code path.
  if (typeof rec.before !== 'string' || typeof rec.after !== 'string') {
    diffCache.set(rec.id, null)
    $.ui.invalidate('ui.render')
    return null
  }
  if (rec.before === rec.after) {
    diffCache.set(rec.id, '')
    $.ui.invalidate('ui.render')
    return ''
  }
  // Write to sibling temp files next to the target so permissions match.
  // Names carry the edit id so two concurrent shows never collide and a
  // crash leaves a discoverable suffix.
  const tag = `.cc-fh-diff-${rec.id}`
  const beforePath = `${rec.filePath}${tag}.before`
  const afterPath = `${rec.filePath}${tag}.after`
  try {
    await $.fs.write(beforePath, rec.before)
    await $.fs.write(afterPath, rec.after)
    const { exitCode, stdout } = await $.process.run([
      'diff',
      '-u',
      '--label',
      `a/${basename(rec.filePath)}`,
      '--label',
      `b/${basename(rec.filePath)}`,
      beforePath,
      afterPath,
    ])
    if (exitCode > 1) return null
    diffCache.set(rec.id, stdout)
    return stdout
  } catch {
    return null
  } finally {
    // Best-effort cleanup; ignore failures (file already gone, etc.).
    void $.process.run(['rm', '-f', beforePath, afterPath])
    // Force a redraw — showDiff already invalidated when the row opened, but
    // that draw saw "computing diff…"; this one shows the result.
    $.ui.invalidate('ui.render')
  }
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Hunk formatter — turn an Edit's (old_string, new_string) pair into one
// minimal unified-diff hunk. The engine's `Code { format: 'diff' }` parses
// these (see `.claude-plugin/types/claude-code/index.d.ts:1553`): a hunk
// header line followed by `-`/`+` lines, no context needed.
// ---------------------------------------------------------------------------

function hunkDiffText(before: string, after: string): string {
  const splitLines = (s: string): string[] => {
    const lines = s.split('\n')
    // Drop the trailing empty entry a final '\n' creates, so a 2-line file
    // "a\nb\n" comes out as ["a", "b"], not ["a", "b", ""]. Without this
    // the unified diff gains a phantom blank line on each side.
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    return lines
  }
  const beforeLines = splitLines(before)
  const afterLines = splitLines(after)
  const header = `@@ -1,${beforeLines.length} +1,${afterLines.length} @@`
  const body = [
    ...beforeLines.map((l) => `-${l}`),
    ...afterLines.map((l) => `+${l}`),
  ].join('\n')
  return `${header}\n${body}`
}

// ---------------------------------------------------------------------------
// Revert helper — closure for each rendered Revert button.
// ---------------------------------------------------------------------------

async function revertById($: EngineInterface, id: number) {
  const rec = edits.find((r) => r.id === id)
  if (!rec || !rec.applied) return

  const choice = await $.ui.ask(
    `Revert ${rec.kind} on ${rec.filePath}?`,
    ['Revert', 'Cancel'],
  )
  if (choice !== 'Revert') return

  try {
    if (rec.kind === 'edit') {
      // Edit record has no full `before` snapshot — we deferred reads at
      // Edit time. To revert, read the current file and find-and-replace
      // new_string → old_string (split().join() does global, so a `replace_all`
      // Edit's many occurrences all get reverted). If new_string isn't in
      // the file any more, a later edit must have rewritten that region;
      // fail loudly rather than silently leave the file in a wrong state.
      if (typeof rec.hunkBefore !== 'string' || typeof rec.hunkAfter !== 'string') {
        throw new Error('edit record missing hunkBefore / hunkAfter')
      }
      const current = await $.fs.read(rec.filePath)
      if (!current.includes(rec.hunkAfter)) {
        throw new Error(
          'new_string no longer in file (a later edit rewrote this region?)',
        )
      }
      const reverted = current.split(rec.hunkAfter).join(rec.hunkBefore)
      await $.fs.write(rec.filePath, reverted)
    } else if (rec.beforeExists) {
      await $.fs.write(rec.filePath, rec.before!)
    } else {
      // Brand-new file from Write — remove it to restore "did not exist".
      const { exitCode } = await $.process.run(['rm', rec.filePath])
      if (exitCode !== 0) throw new Error(`rm exited ${exitCode}`)
    }
    edits = edits.filter((r) => r.id !== id)
    $.ui.toast(`reverted ${basename(rec.filePath)}`)
  } catch (err) {
    const msg = String((err as { message?: string })?.message ?? err)
    $.ui.toast(`revert failed: ${msg}`, { timeoutMs: 6000 })
  }
  $.ui.invalidate('ui.render')
}

// ---------------------------------------------------------------------------
// Pane render (the full list with per-edit Revert buttons and per-row diff).
// ---------------------------------------------------------------------------

type PaneRenderEvent = {
  surface: string
  props?: { bodyColumns?: number }
}

function renderPane($: EngineInterface, e: PaneRenderEvent) {
  type El = (props: Record<string, unknown> & { children?: unknown }) => unknown
  const { Box, Text, Button, Code } = $.ui.resolve(e as never) as {
    Box: El
    Text: El
    Button: El
    Code: El
  }

  const groups = groupByFile(edits)
  const totalFiles = groups.length
  const totalEdits = edits.length

  const closePane = async () => {
    paneOpen = false
    await $.ui.close({ id: PANE_ID })
  }

  const header = Box({
    flexDirection: 'row',
    gap: 1,
    children: [
      // The engine renders Pane chrome in a fixed dark fill in both light
      // and dark terminal modes, but the default Text colour (and the
      // Button label colour) adapts to the terminal — in a light terminal
      // it's dark, on top of the dark chrome that becomes near-invisible.
      //
      // For Text we can pin `color: 'white'` directly. For Button the
      // props don't include `color` (ButtonProps at index.d.ts:1000 only
      // exposes `dimColor`, `variant`, `plain`, `hover`), so `color:
      // 'white'` is silently dropped — that's why the buttons stay
      // invisible after a `color: 'white'` edit. The Button-level escape
      // is `variant: 'primary'`, which makes the terminal render the
      // label in the engine's accent colour (bright in both terminal
      // modes, so it always contrasts with the dark Pane chrome). We
      // mark every Button primary; Close / Show / Revert are the only
      // pressable leaves on each surface, so "the one to press" reads
      // honestly. The status-char accents (red / yellow / green) already
      // sit on the bright side of the palette and need no override.
      Text({ bold: true, color: 'white', children: 'File history' }),
      Text({
        color: 'white',
        children: `${totalFiles} file${totalFiles === 1 ? '' : 's'}, ${totalEdits} edit${totalEdits === 1 ? '' : 's'}`,
      }),
      Box({ flexGrow: 1 }),
      Button({ key: 'close', label: 'Close', variant: 'primary', onPress: closePane }),
    ],
  })

  if (totalEdits === 0) {
    return Box({
      flexDirection: 'column',
      paddingX: 1,
      gap: 1,
      children: [
        header,
        Text({ color: 'white', children: 'no edits captured yet' }),
      ],
    })
  }

  const statusChar = (rec: EditRecord): { char: string; color: string } => {
    if (rec.kind === 'delete') return { char: '×', color: 'red' }
    return rec.beforeExists
      ? { char: 'M', color: 'yellow' }
      : { char: '●', color: 'green' }
  }

const kindLabel = (rec: EditRecord): string => {
  if (rec.kind === 'edit') return 'edit'
  if (rec.kind === 'delete') return 'delete'
  return 'write'
}

  const toggleExpand = (id: number) => {
    if (expanded.has(id)) {
      expanded.delete(id)
    } else {
      expanded.add(id)
    }
    $.ui.invalidate('ui.render')
  }

  const groupBoxes = groups.map((g) => {
    const fileHeader = Box({
      flexDirection: 'row',
      gap: 1,
      children: [
        Text({ bold: true, color: 'white', children: g.filePath }),
        Text({
          color: 'white',
          children: `${g.records.length} edit${g.records.length === 1 ? '' : 's'}`,
        }),
      ],
    })

    const recordRows = g.records.map((rec) => {
      const revert = () => {
        void revertById($, rec.id)
      }
      const isOpen = expanded.has(rec.id)
      const showDiff = () => {
        toggleExpand(rec.id)
        // Kick off the diff (lazily) so the next redraw has something to
        // show. We don't await — toggleExpand's invalidate handles the
        // redraw, and the diff lands as soon as `diff -u` returns.
        if (expanded.has(rec.id)) {
          void unifiedDiff($, rec)
        }
      }
      const status = statusChar(rec)
      const rowChildren: unknown[] = []

      rowChildren.push(Text({ color: status.color, children: status.char }))
      rowChildren.push(Text({ color: 'white', children: formatTime(rec.ts) }))
      rowChildren.push(Text({ color: 'white', children: kindLabel(rec) }))

      if (rec.beforeExists && typeof rec.before === 'string') {
        const lines = rec.before.split('\n').length
        rowChildren.push(
          Text({
            color: 'white',
            children: `(${lines} line${lines === 1 ? '' : 's'} before)`,
          }),
        )
      }

      rowChildren.push(Box({ flexGrow: 1 }))

      // [Show] / [Hide] — only when we have something to diff against. Three
      // independent sources cover all rows: Edit has hunkBefore/hunkAfter
      // from the tool input; Write has before (file read) + after (input
      // content); Delete has `before` only (file content pre-deletion), and
      // `unifiedDiff` renders that as a "removed-everything" diff against
      // /dev/null.
      const hasHunk =
        typeof rec.hunkBefore === 'string' && typeof rec.hunkAfter === 'string'
      const hasFull =
        typeof rec.before === 'string' && typeof rec.after === 'string'
      const hasDelete = rec.kind === 'delete' && typeof rec.before === 'string'
      const canDiff = hasHunk || hasFull || hasDelete
      if (canDiff) {
        rowChildren.push(
          Button({
            key: `diff-${rec.id}`,
            label: isOpen ? 'Hide' : 'Show',
            variant: 'primary',
            onPress: showDiff,
          }),
        )
      } else if (rec.beforeExists && typeof rec.before === 'string') {
        // Have before but no after — the file read after `next(e)` failed.
        // Surface it explicitly so the user knows why the toggle is missing.
        rowChildren.push(Text({ color: 'white', children: '(no diff: after missing)' }))
      } else if (rec.kind === 'edit') {
        // Edit without a hunk shouldn't happen (input always carries it), but
        // be defensive — no message to avoid a misleading "missing".
        rowChildren.push(Text({ color: 'white', children: '(no diff)' }))
      }

      if (rec.applied) {
        rowChildren.push(
          Button({ key: `revert-${rec.id}`, label: 'Revert', variant: 'primary', onPress: revert }),
        )
      } else {
        rowChildren.push(Text({ color: 'white', children: '(failed)' }))
      }

      const mainRow = Box({ flexDirection: 'row', gap: 1, children: rowChildren })

      if (!isOpen) return mainRow

      // Expanded diff section. We pull from the cache synchronously (it may
      // be `undefined` while `diff -u` is still running, or `null` if it
      // failed, or `''` if before === after).
      const diffText = diffCache.get(rec.id)
      const diffBody: unknown[] = []
      if (diffText === undefined) {
        diffBody.push(Text({ color: 'white', children: 'computing diff…' }))
      } else if (diffText === null) {
        diffBody.push(Text({ color: 'white', children: 'diff unavailable' }))
      } else if (diffText === '') {
        diffBody.push(Text({ color: 'white', children: '(no textual change)' }))
      } else {
        // Code truncates at 10000 chars; we slice to the start so a giant
        // diff still draws something. The end-of-input marker tells the
        // user the rest was dropped.
        const MAX = 10_000
        const truncated = diffText.length > MAX
        diffBody.push(
          Code({
            key: `diff-code-${rec.id}`,
            source: truncated ? `${diffText.slice(0, MAX)}\n…(truncated)` : diffText,
            format: 'diff',
            path: rec.filePath,
          }),
        )
      }

      return Box({
        flexDirection: 'column',
        gap: 1,
        paddingLeft: 2,
        children: [mainRow, ...diffBody],
      })
    })

    return Box({
      flexDirection: 'column',
      gap: 1,
      children: [fileHeader, ...recordRows],
    })
  })

  return Box({
    flexDirection: 'column',
    paddingX: 1,
    gap: 1,
    children: [header, ...groupBoxes],
  })
}

// ---------------------------------------------------------------------------
// Register.
// ---------------------------------------------------------------------------

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    resetState()
    await $.command.register({
      name: 'file-history',
      description: 'Open / close the file-edit history pane',
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

  on('command.run', { command: 'file-history' }, async ($) => {
    // Pane toggle. `paneOpen` is best-effort — closing via the engine's X
    // or Esc doesn't reach us, so the next /file-history after that will
    // think the Pane is still open and try to close a now-missing one.
    // `$.ui.close` and `$.ui.open` are both safe to call against a
    // not-placed / already-placed Pane respectively, so the user just sees
    // one "useless" round-trip and we're back in sync.
    if (paneOpen) {
      try {
        await $.ui.close({ id: PANE_ID })
        paneOpen = false
        return { text: 'file-history: closed.' }
      } catch (err) {
        const msg = String((err as { message?: string })?.message ?? err)
        return { text: `file-history: close error: ${msg}` }
      }
    }
    try {
      const r = await $.ui.open({
        id: PANE_ID,
        title: 'File history',
        focus: true,
        closeOnEscape: true,
      })
      paneOpen = r.isPlaced === true
      return r.isPlaced
        ? { text: 'file-history: opened.' }
        : { text: 'file-history: open refused.' }
    } catch (err) {
      const msg = String((err as { message?: string })?.message ?? err)
      return { text: `file-history: open error: ${msg}` }
    }
  })

  on('tool.call', { tool: 'Edit' }, async ($, e, next) =>
    recordTool($, e, 'edit', next) as never,
  )

  on('tool.call', { tool: 'Write' }, async ($, e, next) =>
    recordTool($, e, 'write', next) as never,
  )

  on('tool.call', { tool: 'Bash' }, async ($, e, next) =>
    recordBash($, e as BashToolInput, next as never) as never,
  )

  // Pane: opened on demand by /file-history. Engine-controlled dark chrome
  // is the cost of an interactive sidebar with multiple Buttons — the user
  // pays for the chrome only when they choose to look at the list.
  on('ui.render', { component: 'Pane', requestId: PANE_ID }, ($, e) => {
    return renderPane($, e as never) as never
  })
}