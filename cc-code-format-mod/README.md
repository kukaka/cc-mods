# cc-code-format-mod

A Claude Code mod that runs every fenced code block the model emits through the language's standard formatter, then rewrites the transcript row in place. The LLM no longer hands you code that's two spaces short of PEP 8 or three quotes wide of Prettier.

```diff
- def add(a, b):
-   return  a + b
+ def add(a, b):
+     return a + b
```

```diff
- const greet = (name)=>{
-   return `hi ${name}`
- }
+ const greet = (name) => {
+   return `hi ${name}`;
+ };
```

The rewrite happens inside `session.append { door: 'response' }` — before the row is appended to the transcript and before the next request is built. So the user sees formatted code, the model sees formatted code in its own context, and `git diff` shows clean, idiomatic code rather than the model's first draft.

For install / marketplace / hot-reload setup, see the [parent marketplace README](../README.md).

---

## Configure

The mod is on by default — installing it is opting in. The only configuration is one user field and a slash command that controls it.

### `enabled` (boolean, default `true`)

Master switch. Set to `false` to leave every code block as the model wrote it.

```json
{
  "pluginConfigs": {
    "cc-code-format-mod": { "enabled": false }
  }
}
```

### Runtime control — `/format-code`

A slash command overrides the user config for the current session:

| Command | Action |
|---------|--------|
| `/format-code`              | Toggle on/off |
| `/format-code on`           | Enable |
| `/format-code off`          | Disable |
| `/format-code status`       | Show on/off and verbose state |
| `/format-code verbose`      | Toggle verbose toasts |
| `/format-code verbose on`   | Show toasts after every rewrite |
| `/format-code verbose off`  | Silence toasts |
| `/format-code help`         | Show the table above |

`enabled` is session-scoped — a hot reload (or the next session) re-reads the user config. `verbose` is purely a session toggle; nothing is written to settings.

---

## What you see

The mod draws nothing in the transcript or above the prompt. By default the only visible feedback is:

- **Code blocks reformatted** in every assistant response that contained them.

When verbose toasts are on (`/format-code verbose`), each rewritten response ends with a `formatted N code blocks` (or `skipped N block(s) (formatter error)`) toast.

When a formatter is unavailable (e.g. `black` not installed for a Python block), the block is left exactly as the model wrote it — silent by default, surfaced as a skipped count in verbose mode.

---

## How it works

| Hook | What it does |
|------|--------------|
| `session.start` | Registers the `/format-code` slash command. |
| `command.run { command: 'format-code' }` | Toggle / status handler. |
| `session.append { door: 'response' }` | The hot path. Walks `message.content`, finds `<!-- lang -->` fences in text blocks, formats each body, and rewrites the block via `next({ ...e, message: { ...e.message, content } })`. |

### Fence matching

The regex is permissive enough to accept `<!-- lang -->` style fences with attributes (e.g. ```` ```python hl_lines="1 3" ````):

```
/```([A-Za-z0-9_+\-]*)[^\n]*\n([\s\S]*?)```/g
```

Empty fences and languages in the skip set (`diff`, `plaintext`, `console`, `log`, `shell-session`, `text`, `txt`, `output`, `ansi`) are passed through untouched.

### Formatter dispatch (first match wins)

1. **Prettier** — `npx --yes prettier@3 --parser <p>`. Handles the web stack: JavaScript / TypeScript / JSX / TSX, JSON, CSS / SCSS / Less, HTML, Vue / Svelte / Astro / Angular, YAML, Markdown / MDX, GraphQL, TOML. The first invocation triggers `npx` to download Prettier (~5 MB), cached thereafter.
2. **Stdin-CLI tools** — `python3 -m black - --quiet --code` (Python), `gofmt` (Go), `shfmt -i 2 -` (bash / sh / shell / zsh).
3. **File-path tools** — `rustfmt` (Rust). The body is materialised to `/tmp/cc-code-format-mod/<random>.rs`, then the formatted file is read back. Unique filenames per call so concurrent requests don't race.

Anything not in those three tables is left as-is.

### Timeouts and failures

Each format call has its own timeout — 15 s for Prettier, 10 s for native tools. Exceeding it, a non-zero exit code, an empty stdout, a missing tool, or a network error during `npx` download: the original block is kept and (in verbose mode) the response ends with a `skipped N block(s)` toast. The hook never throws back to the engine.

### State

Only `cc-code-format-mod.stats` lives in `$.state` — `{ formatted, skipped, failed }` counters that accumulate across the session and survive hot reloads. The `enabled` flag is a mirror of `userConfig` and lives in a module-level `let`; the verbose flag is session-only and toggled by `/format-code verbose`.

---

## Limitations

- **Formatter availability.** A Python block stays unformatted unless `python3 -m black` works. No auto-install.
- **Time-bounded.** A 15 s budget per Prettier block is generous but unbounded — a multi-megabyte file may be skipped.
- **Single-shot.** The hook formats the response row as it lands; it does not re-format past responses. Use `/format-code` to toggle and re-run the next request.
- **Fence-only.** Inline code spans (`like this`) and indented code blocks inside lists are left alone.
- **`npx` first run is slow.** ~5 MB Prettier download on first call. Subsequent calls are cached by `npm`.
- **rustfmt temp files accumulate** in `/tmp/cc-code-format-mod/` until you clean the dir. Each filename is unique and small; OS-level `/tmp` cleanup eventually takes them.

---

## Inspiration

- [Claude Code docs — Mods overview](https://code.claude.com/docs/en/plugins/mods/overview) and [the in-process API declaration](https://code.claude.com/docs/en/settings) (`.claude-plugin/types/claude-code/index.d.ts` after first load).
- [blast-radius](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/blast-radius) and [token-weather](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/token-weather) — sibling mods showing the `tool.call` and `ui.render` patterns this mod doesn't use.