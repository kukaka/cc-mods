# cc-file-history-mod

A Claude Code mod that captures every file Claude has edited this session
and lets you revert any one of them. Single surface:

- **Pane** (opened on demand by `/file-history`) — the full file-grouped
  list with one `[Revert]` per edit. Has the engine's dark chrome (a
  fixed engine choice, not plugin-controllable), so on a light terminal
  it looks wrong; we open it explicitly only when the user actually
  wants to look at the list or revert.

Open and close it with the slash command:

```
/file-history
```

`/file-history` toggles the Pane: first call opens it, second closes.
Closing via the engine's `[X]` / `Esc` also dismisses it; the next
`/file-history` will figure out which way to flip from our local flag
(and waste one round-trip if the flag went stale).

The **first** successful `Edit` / `Write` of a session auto-opens the
Pane — there's no other way for the user to know something happened.
After the auto-open, the Pane is yours: `/file-history` toggles it,
the engine's `[X]` / `Esc` closes it, and **a manual close sticks** —
subsequent edits do not pop the Pane back up. `/clear` / `/resume` /
`/fork` resets the edits list, so the next edit in the new session
will auto-open again.

## What you see

### Pane

```
┌─ File history ──────────────────────── 2 files, 4 edits ─── [ Close ] ┐
│ src/hooks/register.tsx  3 edits                                       │
│ ●  10:42:13  write  (created)        Show    [ Revert ]                │
│ M  10:40:02  edit  (82 lines before) Show    [ Revert ]                │
│ M  10:38:51  edit  (78 lines before) Show    [ Revert ]                │
│ src/hooks/history.ts  1 edit                                          │
│ M  10:41:10  edit  (54 lines before) Show    [ Revert ]                │
└───────────────────────────────────────────────────────────────────────┘
```

- **One group per file**, sorted by most recent edit first.
- **Each row is one `Edit` or `Write`** Claude issued, newest first.
- **VSCode-style status** to the left of each row:
  - `●` (green) = brand-new file (the `Write` created it; revert will `rm`).
  - `M` (yellow) = modification to an existing file (Edit / Write).
  - `×` (red) = deletion — `Bash` tool ran `rm` (or equivalent). Revert
    writes the captured pre-deletion content back.
- **`Show` / `Hide`** expands a row to a real unified diff (`before`
  → `after`) rendered with the engine's syntax highlighter. Computed
  lazily on first expand and cached; reopening a row uses the cached
  diff. Diffs over 10 000 characters are truncated with a trailing
  `…(truncated)` marker.
- **`Revert`** restores the file to the state it was in **before** that
  one tool call. Pressing it raises a confirmation dialog first; choose
  `Revert` to proceed, `Cancel` to keep the file as-is. For `Write` that
  created a brand-new file, **Revert** deletes the file (the pre-edit
  state was "did not exist").

## How it works

| Hook | Why |
| --- | --- |
| `session.start` | Reset history, register `/file-history`. |
| `classic.SessionStart { clear \| resume \| fork }` | Same reset on `/clear`, `/resume`, `/branch`. |
| `command.run { command: 'file-history' }` | Open / close the Pane via `$.ui.open` / `$.ui.close` with `PANE_ID`. |
| `tool.call { tool: 'Edit' }` | Snapshot `before` via `$.fs.read`, run the edit, snapshot `after`, record the row. |
| `tool.call { tool: 'Write' }` | Same. If `$.fs.read` of the pre-write path rejects, set `beforeExists = false` so Revert falls back to `rm`. |
| `tool.call { tool: 'Bash' }` | Record file deletions. Two paths to the deletion set: (a) `result.result.bashEditDiff.files[].deleted: true` (catches shell-internal deletes our parse can't see — `mv a /dev/null`, `find -delete`, globs the shell expanded), (b) `$.fs.stat` probe of every candidate we pre-read (the reliable path for plain `rm path` in this build — the engine doesn't populate `bashEditDiff` for `rm`). Pre-read candidate content (via `parseRmCandidates` + `$.fs.read`) is what makes Revert-able. |
| `ui.render { component: 'Pane', requestId: PANE_ID }` | Render the file-grouped edit list with `[Show]/[Hide]` and `[Revert]` per row. |

A `Revert` is a Button `onPress` closure — each button captures its edit
ID in JS scope, calls `$.ui.ask` for confirmation, then either
`$.fs.write(path, before)` (the common case) or `$.process.run(['rm',
path])` (for a brand-new file). On success the entry is removed from the
list and a toast says `reverted <basename>`. On failure a 6-second toast
shows the error.

The snapshot is the file's full content read via `$.fs.read` just before
the tool call runs; the `after` snapshot is read right after. This makes
Revert exact — even for an `Edit` that touches one line, we restore the
entire file's pre-edit text — and gives the diff display real before/after
content to compare, not just "what was here before".

The diff is rendered with the engine's `Code { format: 'diff' }`. Two
paths produce the unified-diff text:

- **Edit** — `old_string` / `new_string` are already in the
  `tool.call` input, so we don't `$.fs.read` the file at all. The hunk
  formatter (`hunkDiffText` in `hooks/register.tsx`) turns the pair into
  one minimal unified-diff hunk (`@@ -1,N +1,M @@` + `-` / `+` lines). No
  `diff -u` shell out for Edits — these are tiny hunks.
- **Write** — the input has the new `content`, but no old content. We
  `$.fs.read` the file before `next(e)` for the `before` snapshot; the
  `after` is the input's `content` directly (no second `$.fs.read`). The
  full before/after pair is shelled to `diff -u` like before — these can
  be arbitrarily large.

Edit's Revert uses a different strategy from Write's: with no full
`before` snapshot, we read the file at Revert time and find-and-replace
`new_string` → `old_string` (global, so a `replace_all` Edit's many
occurrences all revert). If a later edit has rewritten that region and
`new_string` no longer appears, Revert refuses and toasts the error
rather than silently leaving the file in a wrong state. Write's Revert
writes the full `before` back, exactly as before.

The history is **session-scoped** and lives in module-local state. A
session.start, `/clear`, `/resume`, `/branch`, or a hot reload wipes it.
There is no persistence across sessions — by design, snapshots could be
large and stale across checkpoints.

## Configure

For v1, configuration is module-local constants in `hooks/history.ts` /
`hooks/register.tsx`:

| Constant | Default | Purpose |
| --- | --- | --- |
| `MAX_ENTRIES` | `200` | Hard cap on total entries. Drop the oldest when over. |
| `PANE_ID` | `'cc-file-history-mod-pane'` | The pane's id (one per id; reopening retitles). |

## Limitations (v1)

- **No `MultiEdit` or `NotebookEdit`** — only `Edit` and `Write` are
  recorded. `MultiEdit` is not declared in this build's
  `BuiltinToolInputs`.
- **Bash deletions: globs and `$VAR` expansions** — the parser sees the
  literal `*.txt` / `$FOO`, so we read the wrong path (or nothing) before
  Bash runs. `bashEditDiff` does report the expanded files as deleted,
  but we have no content for them (the file is gone by the time we get
  the diff). Result: the deletion is logged with no Revert-able content.
  Walk-cwd-and-expand-glob, or shell-var tracing, would fix this — not
  implemented.
- **No cross-session persistence** — reloads and `/clear` wipe history.
- **No multi-edit undo** — one revert per record. Reverting in reverse
  order is the user's job.
- **No git integration** — we don't run `git stash` / `git checkout`;
  revert is a plain file write (or `rm`).
- **No path-traversal guard** — we trust the model's `file_path`.
- **Pane chrome is dark** — the engine controls pane chrome color, so
  the Pane is dark on light terminals. Open it when you actually want
  the full list or to revert; the engine's chrome is the price of
  having multiple Buttons and a `[Revert]` confirmation dialog.
- **`paneOpen` flag can lag** — if you close the Pane via the engine's
  `[X]` or `Esc`, our local `paneOpen` is unaware until the next
  `/file-history`, at which point the toggle flips the wrong way once
  before catching up. Both `$.ui.open` and `$.ui.close` are safe to
  call against a missing/already-placed Pane, so the cost is one
  round-trip.
- **Auto-open requires ≥ 110 columns OR a prior manual `/file-history`** —
  on narrow terminals (< 110 cols), the engine only places a Pane if the
  user has explicitly opened it before. A plugin-initiated `$.ui.open`
  from `recordTool` counts as "unasked" and the engine returns
  `isPlaced: false` with reason `below 110 columns`. The first edit will
  still be captured (so subsequent `/file-history` will show it), but
  the Pane won't pop up automatically until you `/file-history` once
  yourself (or widen the terminal to ≥ 110 cols so it docks
  unconditionally). The toast on auto-open failure makes this explicit.

## Develop

This mod lives in a marketplace folder, so:

```bash
# From /Users/lixinghui/Documents/code/fe/testground/cc-mods
claude plugin validate ./cc-file-history-mod
claude plugin test ./cc-file-history-mod
```

End-to-end:

```bash
claude --plugin-dir ./cc-file-history-mod
# inside: ask Claude to Edit a file, then type /file-history, then [Show] /
# [Revert] on any edit.
```