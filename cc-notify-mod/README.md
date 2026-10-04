# cc-notify-mod

Forward Claude Code lifecycle events to the macOS Notification Center so you hear about them when you are away from the terminal. Three event sources, three notification levels:

| Event                          | Level     | Subtitle             | Sound | Body                                        |
|--------------------------------|-----------|----------------------|-------|---------------------------------------------|
| `turn.complete` (not aborted)  | info      | `[Task Complete]`    | Glass | first line of Claude's answer               |
| `Bash` failed N times in a row | warn      | `[Bash failed N×]`   | Basso | first line of the error output              |
| `AskUserQuestion` rendered     | important | `[Claude is asking]` | Frog  | the question Claude is asking               |

For install / marketplace / hot-reload setup, see the [parent marketplace README](../README.md).

---

## Configure

Three user-configurable knobs; everything else lives as code constants in `register.mjs`.

### `enabled` (boolean, default `true`)

Master switch. When false, no system notifications are sent at all.

```json
{
  "pluginConfigs": {
    "cc-notify-mod": { "enabled": false }
  }
}
```

### `suppressWhenFocused` (boolean, default `true`)

Skip notifications when Claude Code is the frontmost app. The check is by foreground application name via `osascript` against a built-in allowlist (Terminal / iTerm2 / Warp / Alacritty / kitty / WezTerm / Ghostty / Hyper / Claude). Set to `false` to notify regardless of focus.

### `stickyOnError` (boolean, default `false`)

Reserved for warning notifications. macOS's `display notification` does not have a sticky option; this knob is honored by future code that may route through `terminal-notifier` or `BurntToast`. Today it is accepted silently — warnings still auto-dismiss after a few seconds.

```json
{
  "pluginConfigs": {
    "cc-notify-mod": {
      "enabled": true,
      "suppressWhenFocused": true,
      "stickyOnError": false
    }
  }
}
```

### Code-level defaults (edit `register.mjs` to change)

| Constant             | Default | Meaning                                                |
|----------------------|---------|--------------------------------------------------------|
| `SUPPRESS_IF_UNDER_MS` | `5000` | Skip `turn.complete` notifications for sub-5s turns    |
| `RETRY_COUNT`        | `3`     | Trigger a `warn` after this many consecutive failures of the same command |
| `RETRY_RESET_MS`     | `60000` | A successful run of the same command clears its counter |
| `FOCUSED_NAMES`      | 10 apps | Apps that count as "the user is watching the terminal" |

`FOCUSED_NAMES` is the allowlist the foreground probe checks against. If you run Claude Code from a terminal not on the list (Tabby / Rio / Contour / VS Code integrated terminal / etc.), add its `osascript` name to the set in `register.mjs`. To find the exact string, run:

```bash
osascript -e 'tell application "System Events" to get name of first application process whose frontmost is true'
```

while your terminal is focused — paste whatever it prints.

---

## What you see

### Notification Center

```
Claude Code                          [Task Complete]
Done: implemented user auth in src/api/users.ts.
```

```
Claude Code — repeated failure       [Bash failed 3×]
tsc: src/api/users.ts:42:5 — error TS2322: Type 'string' is not assignable to type 'number'.
```

```
Claude Code                          [Claude is asking]
Which auth provider should we wire up: Google, GitHub, or email magic-link?
```

Clicking a notification does nothing for now (the `display notification` AppleScript verb does not support click handlers). Tapping anywhere on the desktop dismisses; the answer remains visible in the terminal.

### Suppression rules (apply to all three notification kinds)

- **Master switch off** — nothing is sent.
- **suppressWhenFocused on AND terminal is frontmost** — skipped.
- **`turn.complete` and turn took < `SUPPRESS_IF_UNDER_MS`** — skipped (sub-5s turns are usually typing aids, not finished work).
- **Aborted turn (`turn.complete` with `isAborted: true`)** — skipped (you pressed it).
- **`tool.check` deny / permission prompt** — not currently notified.
- **Notification Center permission denied** — `osascript` rejects, the call is swallowed silently. Re-authorize in System Settings → Notifications → Script Editor.

---

## How it works

| Hook                                                    | What it does                                                          |
|---------------------------------------------------------|-----------------------------------------------------------------------|
| `session.start`                                         | Resets per-session state and re-probes focus.                         |
| `classic.SessionStart { source: 'clear'\|'resume'\|'fork' }` | Same reset on `/clear`, `/resume`, `/branch` (the mod-native `session.start` does not fire on these). |
| `turn.start`                                            | Stamps `lastTurnStartedAt` so `turn.complete` can compute duration.   |
| `turn.complete`                                         | Notifies `info` when the main-loop turn (no `agentId`) finishes cleanly and is long enough. |
| `tool.call { tool: 'Bash' }` (post)                     | Tracks per-command failure counts in a `Map`. After `RETRY_COUNT` consecutive failures of the same command, notifies `warn`. |
| `ui.render { component: 'AskUserQuestion' }`            | Notifies `important` when Claude renders a question dialog.           |

The foreground check is one `osascript` call:

```text
tell application "System Events" to get name of first application process whose frontmost is true
```

The notification is one `osascript` call:

```text
display notification "<body>" with title "<title>" subtitle "<subtitle>" sound name "<sound>"
```

Both can throw if `osascript` is missing or if Notification Center permission was revoked — both paths are caught and the mod falls back to silent (no notification) rather than failing the hook.

### Failure signature

`Bash` retries are keyed by `<cwd>::<command>` so:

- The same command run from two worktrees has two counters — neither trip the other.
- A successful re-run clears the counter for that signature.
- Stale entries are GC'd after `RETRY_GC_MS` (5 minutes) of inactivity, capped at 64 entries.

### State

All state lives in module-level variables (`let`s and one `Map`) and resets on hot reload. After `/clear`, `/resume`, `/branch` the same reset runs via `classic.SessionStart`, so retries drop and the focus cache is re-probed before the next turn.

---

## Platform support

| Platform | Status       | Notes                                                            |
|----------|--------------|------------------------------------------------------------------|
| macOS    | Full         | The only platform targeted in v1. Built-in `osascript`.          |
| Linux    | Not supported | `osascript` is unavailable. A future version could fall back to `notify-send` — open an issue if you want this. |
| Windows  | Not supported | Same — `osascript` is unavailable. `BurntToast` integration is a possible follow-up. |

The mod still loads on Linux/Windows: hooks register, the foreground-probe returns `"unknown"` (the `osascript` probe at `session.start` fails, so `osascriptOk = false` and `notify` short-circuits). No real notification fires — silently.

---

## Limitations

- **macOS only** for v1. Linux and Windows paths are deferred.
- **No click handlers.** `display notification` cannot route a click back to the terminal; you have to switch focus manually.
- **Foreground probe is approximate.** `System Events` requires Accessibility permission for some apps; in that case the probe returns `unknown` and notifications still fire (better to over-notify than miss).
- **No quiet hours yet.** No way to silence during specific windows.
- **AskUserQuestion probe may fire on dialog opens that don't actually need an answer.** The hook triggers when the dialog renders; if you dismiss it instantly, the notification is still sent.

---

## Inspiration

- Claude Code docs — [Mods overview](https://code.claude.com/docs/en/plugins/mods/overview) and [the in-process API declaration](https://code.claude.com/docs/en/settings) (`.claude-plugin/types/claude-code/index.d.ts` after first load).
- [`token-weather`](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/token-weather) — AbovePrompt band layout pattern, and the hot-reload state-reset rationale (which this mod also follows).
- [`blast-radius`](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius) — `tool.call` post-call interception pattern (observation + short-circuit on error).
- Apple `display notification` and `System Events` — documented in `osascript` Standard Additions.
