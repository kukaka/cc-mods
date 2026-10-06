// Pure helpers for cc-file-history-mod. No `$.` imports — every function here
// is engine-independent and exercised directly by tests/history.test.ts.
//
// The shape of an EditRecord is the contract between the hooks module
// (register.tsx) and the rendering code: an in-memory list of these is the
// mod's only state, and history.* is what the renderer reads.

export const MAX_ENTRIES = 200

export type EditKind = 'edit' | 'write' | 'delete'

export type EditRecord = {
  /** Monotonic, scoped to the session; used as a React-style key in JSX. */
  id: number
  /** Canonicalised via $.fs.stat(path, { resolve: true }) when available. */
  filePath: string
  kind: EditKind
  /** The `tool_use_id` `tool.call` carried; preserved for debugging. */
  toolUseId: string
  /** Wall-clock ms at the moment the tool call began. */
  ts: number
  /** False for a `Write` that created a brand-new file. */
  beforeExists: boolean
  /**
   * Full file content before the edit. Always populated for `Write` (we
   * `$.fs.read` it before the tool runs); `undefined` for `Edit` because the
   * engine's `tool.call` input already has the diff hunk (`hunkBefore` /
   * `hunkAfter`) and reading the full file just for Revert is a cost we
   * skip — Edit's Revert does a `new_string → old_string` find-and-replace
   * on the current file instead. `undefined` when `!beforeExists`.
   */
  before: string | undefined
  /**
   * Full file content right after `next(e)` returned. Set for `Write` from
   * the input's `content` (no second `$.fs.read`); `undefined` for `Edit`
   * (the engine's input has the hunk; full file is irrelevant).
   */
  after?: string | undefined
  /**
   * The changed region only — what `old_string` / `new_string` carry in the
   * `Edit` tool input. We form a minimal unified-diff hunk from these in
   * `unifiedDiff` so we don't shell out `diff -u` for `Edit`. Set for `Edit`
   * only; `undefined` for `Write` (its full before/after diff uses `before` /
   * `after`).
   */
  hunkBefore?: string | undefined
  hunkAfter?: string | undefined
  /** True once `next(e)` returned without `isError` / `deny`. */
  applied: boolean
}

// --- list ops -------------------------------------------------------------

/** Keep the last `max` entries; original ordering preserved. */
export function cap<T>(records: readonly T[], max: number): T[] {
  return records.length <= max ? records.slice() : records.slice(-max)
}

/**
 * Group records by file path, file groups sorted by most-recent record first,
 * records within a group sorted most-recent first.
 */
export function groupByFile(
  records: readonly EditRecord[],
): Array<{ filePath: string; records: EditRecord[] }> {
  const byFile = new Map<string, EditRecord[]>()
  for (const r of records) {
    const key = canonicalPath(r.filePath)
    const list = byFile.get(key) ?? []
    list.push(r)
    byFile.set(key, list)
  }
  const groups: Array<{ filePath: string; records: EditRecord[] }> = []
  for (const [filePath, recs] of byFile.entries()) {
    recs.sort((a, b) => b.ts - a.ts)
    groups.push({ filePath, records: recs })
  }
  groups.sort((a, b) => {
    const at = a.records[0]?.ts ?? 0
    const bt = b.records[0]?.ts ?? 0
    return bt - at
  })
  return groups
}

// --- path / display helpers -----------------------------------------------

/** Normalise separators and collapse `./` for use as a grouping key. */
export function canonicalPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/\.\//g, '/')
}

/** Last segment of a path, regardless of separator. */
export function basename(p: string): string {
  const norm = p.replace(/\\/g, '/')
  const i = norm.lastIndexOf('/')
  return i < 0 ? norm : norm.slice(i + 1)
}

/**
 * Cheap "+N / -M" line-count delta without invoking a real diff. Suitable
 * for a small inline label; the renderer still shows the full content
 * snapshot on revert.
 *
 * Empty / undefined input counts as 0 lines; a non-empty string ending in
 * `\n` is one line shorter than its `split('\n').length` (the trailing
 * empty entry) — we don't bother correcting that, the label is approximate.
 */
export function diffStats(
  before: string | undefined,
  after: string | undefined,
): { added: number; removed: number } {
  const b = before ? before.split('\n').length : 0
  const a = after ? after.split('\n').length : 0
  const delta = a - b
  if (delta === 0) return { added: 0, removed: 0 }
  return delta > 0 ? { added: delta, removed: 0 } : { added: 0, removed: -delta }
}

/** `HH:MM:SS` from a wall-clock ms. */
export function formatTime(ts: number): string {
  const d = new Date(ts)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}