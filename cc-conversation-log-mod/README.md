# cc-conversation-log-mod

A Claude Code mod that shows every user and assistant message in the **current session** as a read-only panel. Two surfaces:

- **AbovePrompt band** — auto-shown once there is at least one message. One row: `▶ History: 5 user, 5 assistant, 14 tools` plus a `[ View ]` button (hotkey `h`). Click or press `h` to open the Pane. Hidden while the Pane is open so the title bar isn't duplicated.

- **Pane** (on demand, via the band's `[ View ]` or `/history`) — one row per message in the current session, newest at the bottom. Each assistant message with tool calls collapses them into `[ ▶ 3 tools ]`; click the disclosure to expand into a per-tool block with `input` and `result`. A `[ Load 50 earlier ]` button at the top grows the page window one step at a time, up to the whole transcript.

The slash command is the secondary surface — the band is the entry point:

```
/history
```

`/history` toggles the Pane. Closing via the engine's `[X]` or `Esc` also dismisses it; the `on('ui.close', ...)` hook keeps our local flag in sync so the next `/history` always flips the right way. `/clear` / `/resume` / `/fork` resets the page window to its default (newest 50) and clears any expanded tool-call groups.

## What you see

### Band

```
▶ History: 5 user, 5 assistant, 14 tools                [ View ]
```

- One row above the prompt. Magenta text + a `[ View ]` button (hotkey `h`).
- Counts `N user, N assistant, N tools`; pluralises correctly.
- Hidden when there are zero messages (visual noise) and while the Pane is open (its header already shows the same counts).
- Plain `Box({ flexDirection: 'row', gap: 2, paddingX: 1, children: [Text, Button] })` shape — no nested Boxes, no `flexGrow: 1`, no `flexWrap`. Same constraint cc-file-history-mod settled on.

### Pane

```
┌─ Conversation log ─────── 5 user, 5 assistant, 14 tools ─ [ Close ] ┐
│ [ Load 50 earlier · 87 more older ]                                    │
│ Showing 50 of 137 messages (newest at bottom).                          │
│                                                                        │
│ 👤 You — 130th                                                          │
│ What's the difference between a class and a struct in C++?            │
│                                                                        │
│ 🤖 Claude — 131st                                                      │
│   In C++ a `class` and a `struct` are essentially the same thing —     │
│   the only difference is the default visibility ...                    │
│   [ ▼ 3 tools ]                                                        │
│     📖 Read: cc-mods/README.md            ✓ 12.3k chars · 320 lines   │
│       input                                                           │
│         { "file_path": "cc-mods/README.md" }                            │
│       result                                                           │
│         # cc-mods ...                                                  │
│   ...                                                                  │
│ ...                                                                    │
```

- **One group per message**, ordered oldest-first at the top, newest at the bottom (the Pane's default scroll position lands the latest row near the visible area).
- **Each row's header** carries an emoji (`👤` / `🤖`), the role, and the message's ordinal position in the transcript (e.g. `131st`). The transcript doesn't carry per-message timestamps as part of `SessionMessage`, so the ordinal is the most stable label we have.
- **User text** is rendered as plain `Text` so what the user typed reads back verbatim.
- **Assistant text** is rendered as `Markdown` for the same styling the engine uses in the transcript.
- **Tool calls** are collapsed when an assistant message has any. The disclosure glyph (`▶` / `▼`) reflects whether *all* tools in the message are open — a partially-expanded group reads as collapsed (clicking `▼`/`▶` expands everything). The `[ Show ] / [ Hide ]` button per tool handles fine-grained toggling.
- Each tool row's header shows the tool's glyph (📖 Read, 🖥 Bash, etc.), a one-line label summarising the input (`Bash: ls -la`, `Read: cc-mods/README.md`), and the result headline (`✓ 12.3k chars · 320 lines` / `✗ error` / `⏳ in flight`).
- Expanded tool rows show the full `input` and `result` as `Code { format: 'text' }` blocks. Both truncate at 4000 chars with a `…(+N chars)` marker so a 50KB Bash result doesn't blow up the Pane.
- **`[ Load 50 earlier · N more older ]`** appears at the top while the page window is smaller than the transcript by a full page. Each click grows the window by 50; once fewer than 50 messages remain hidden, the label switches to `[ Jump to oldest ]` for one-tap viewing.
- **`[ Refresh ]`** clears the page window back to the newest 50 and collapses all expanded tool groups — useful after a long session that has accrued many expanded rows.
- **`[ Close ]`** closes the Pane (matches the engine's `X` / `Esc`, both of which also fire `ui.close`).

## How it works

All data is read from `$.session.messages()` on each Pane render — the engine gives us up to 4096 messages, opening on a user message. There is no module-local cache: the engine call is cheap, and adding a cache would mean guessing when it's stale. A `Refresh` button plus the natural rhythm of `ui.render` (which fires after every action) means the data is always current.

| Hook | Why |
| --- | --- |
| `session.start` | Reset page window, register the `/history` slash command. |
| `classic.SessionStart { clear \| resume \| fork }` | Reset page window + expanded groups on `/clear`, `/resume`, `/branch` (no fresh `session.start` fires on these). |
| `command.run { command: 'history' }` | Toggle the Pane. |
| `ui.render { component: 'AbovePrompt' }` | Draw the band tree (`▶ History: …` + `[ View ]`). Yields `next(e)` when there are zero messages or the Pane is open. Composes with `next(e)` (typically cc-context-mod's band) via a column Box when both bands are present. |
| `ui.render { component: 'Pane', requestId: PANE_ID }` | Render the message list with paging controls and collapsible tool groups. |
| `ui.close { id: PANE_ID }` | Keep `paneOpen` in sync when the engine closes the Pane (Escape, X). |

`paneOpen` is the same shape cc-file-history-mod uses — best-effort mirrored from the engine so the next `/history` always goes the right way.

## Why these design choices

- **Pane, not just a band.** A session can have hundreds of messages; cramming even fifty into a band would scroll past the prompt area. The Pane has its own scroll window (`e.scroll.offset`, `e.scroll.bodyRows`), so a long view stays navigable.
- **Read-only.** The mod doesn't open a turn or call `$.prompt.submit`. Drawing the transcript doesn't need to mutate it; the only mutations are the page window and the expanded set, both module-local.
- **`Markdown` only for assistant text.** User prompts are usually short and `Text` keeps `<` and `>` literal (which a Markdown render would escape and break how the user wrote it).
- **40 KB / row truncation, not unlimited `Code`.** A Bash that produces 50 KB of `ls -la` should still let the rest of the Pane render. Truncation keeps the pane responsive.
- **Page = newest 50.** This is enough for a glance at "what did we just do?" without losing the engine's small-message-efficiency on first render. The page is paginatable, not stream-paginated: there's no separate page-of-history state to track.
- **No `$.store`.** Conversation history lives in the engine's transcript; persisting a copy across sessions is wasteful (the transcript is the source of truth) and would create a divergence the user would notice if they ever fixed a corrupted file (`--continue` would replay from disk, not from our cache).

## Configure

All knobs are module-local constants in `hooks/format.ts` / `hooks/register.tsx`:

| Constant | Default | Purpose |
| --- | --- | --- |
| `PAGE_SIZE` | `50` | How many messages `[ Load earlier ]` adds per click. |
| `DEFAULT_WINDOW` | `50` | The newest messages shown on first open of the Pane. |
| `MAX_TEXT_CHARS` | `4_000` | Truncation cap per `input` / `result` / message-text block. |
| `MAX_PREVIEW_CHARS` | `200` | Truncation cap for the inline tool label (`Bash: ls -la …`). |
| `PANE_ID` | `'cc-conversation-log-mod-pane'` | The Pane's id (one per id; reopening retitles). |
| `COMMAND_NAME` | `'history'` | The slash command's name. |

## Limitations (v1)

- **No per-message timestamps.** `SessionMessage` doesn't carry a wall clock; only the transcript file does, and we'd rather not read it. The message ordinal (`131st`) and the band counts (`5 user, 5 assistant, 14 tools`) are the navigational anchors we have.
- **Cap at the engine's window.** `$.session.messages()` returns up to 4096 messages, opening on a user one. Compaction summary messages earlier in the transcript don't appear in either form, by design. Paging doesn't get around this cap — once the engine has compacted old messages, they're gone.
- **No `agentId` support.** Only the main conversation is shown. Subagents' transcripts are reachable via `$.session.messages({ agentId })` and a future version could open a second Pane for them; not implemented in v1.
- **Assistant text re-parsed.** `Markdown` re-renders what the engine already showed in the transcript. Identical themes today, but if the engine's Markdown dialect changes, the two renders could drift apart.
- **`paneOpen` flag can lag** (same caveat cc-file-history-mod has). X / `Esc` immediately fires `on('ui.close', ...)` so the next `/history` is in sync.
- **Narrow terminals (< 110 cols)** — opening the Pane returns `isPlaced: false` with `reason: below 110 columns`. The toast tells the user and the band stays visible. Widen the terminal and the next click / `/history` will place.
- **No cross-session persistence** by design — see [Why these design choices](#why-these-design-choices).

## Develop

This mod lives in a marketplace folder, so:

```bash
# From /Users/lixinghui/Documents/code/fe/testground/cc-mods
claude plugin validate ./cc-conversation-log-mod
claude plugin test ./cc-conversation-log-mod
```

End-to-end:

```bash
claude --plugin-dir ./cc-conversation-log-mod
# inside: send a few prompts, then type /history. Click [▼ N tools] on
# one of the assistant rows to expand a tool call; click [Load 50 earlier]
# to grow the page window if the session is long.
```
