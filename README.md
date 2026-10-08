# cc-mods

Personal Claude Code mods, packaged as a [local marketplace](https://code.claude.com/docs/en/settings#marketplaces). One folder per mod, each is a self-contained Claude Code plugin.

```
cc-mods/
├── .claude-plugin/marketplace.json     ← declares the marketplace + lists the mods
├── cc-context-mod/                     ← mod: live context weather + MiniMax M Plan balance
├── cc-code-format-mod/                 ← mod: rewrites every code block to standard style
├── cc-notify-mod/                      ← mod: macOS Notification Center for task completion
└── (future mods drop here)
```

## Mods

| Mod                                            | What it does                                                                                                                                                             |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [`cc-context-mod`](./cc-context-mod)           | One-line dashboard above the prompt: context window weather (left) + MiniMax M Plan / Token Plan balance (right).                                                        |
| [`cc-code-format-mod`](./cc-code-format-mod)   | Reformats every fenced code block in an LLM response to the language's standard style (Prettier, black, gofmt, rustfmt, shfmt) before the row lands in the transcript.   |
| [`cc-notify-mod`](./cc-notify-mod)             | Forwards `turn.complete` / repeated `Bash` failures / `AskUserQuestion` prompts to the macOS Notification Center when you are away from the terminal.                    |
| [`cc-file-history-mod`](./cc-file-history-mod) | Panel listing every file Claude has edited this session, with a one-click **Revert** per edit that restores the file to its pre-edit content. Open with `/file-history`. |

## Install

This is a local marketplace — point Claude Code at the folder:

```bash
claude plugin marketplace add ./cc-mods
claude plugin install cc-context-mod@cc-mods --scope user
```

`claude plugin list` should then show the mod with `Read from: ./cc-mods/cc-context-mod` — which means Claude Code is reading the source directly. **Any edit to the mod's source hot-reloads on the next turn, no reinstall needed.**

To remove:

```bash
claude plugin uninstall cc-context-mod@cc-mods
claude plugin marketplace remove cc-mods
```

## Alternative install: in-place via `CLAUDE_CODE_PLUGIN_DIRS`

The marketplace install path runs every mod through the engine's
"marketplace-installed" loading path. For mods that draw UI
(AbovePrompt band, Pane, status line, toast) that path can fail to
draw on some engine versions — the mod's `ui.render` handler runs,
but the engine ignores the return value, so only the engine's own
defaults appear above the prompt. `cc-file-history-mod` hits this
on every observed install.

The fix is to load the mod the same way `claude --plugin-dir` does —
**in place from the source directory** — but persistently, every
session. Set `CLAUDE_CODE_PLUGIN_DIRS` in `~/.claude/settings.json`
(user scope) or the project's `.claude/settings.json` (project
scope):

```jsonc
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": ".\\cc-mods\\cc-file-history-mod;.\\cc-mods\\cc-context-mod;.\\cc-mods\\cc-code-format-mod",
  },
}
```

Rules:

- Paths are **absolute**; relative paths do not resolve.
- Separator is **`;` on Windows**, **`:` on macOS / Linux** (same as
  `PATH`).
- Each entry must be a mod's root directory (the one containing
  `.claude-plugin/plugin.json`), or a folder of mods.
- Precedence: a `CLAUDE_CODE_PLUGIN_DIRS` plugin **replaces** a
  same-named marketplace-installed plugin, so the two can coexist
  without double-loading. You can leave `claude plugin install`
  entries in `enabledPlugins` and they will be ignored while the env
  var is set.
- `CLAUDE_CODE_PLUGIN_DIRS` is an env var, so `/reload-plugins` does
  **not** re-read it. **Quit and relaunch Claude Code** after editing
  `settings.json`. Source edits inside any listed mod hot-reload on
  the next turn, same as a marketplace install — you only need to
  restart when the env var itself changes.

This is the recommended install path for every mod in this repo,
especially when you are actively editing them: same in-place loading
as `--plugin-dir`, persistent across sessions, no
`claude plugin install` round-trip on every change.

## Using a mod

After install, just start Claude Code. The mod hooks in automatically — no command to type, no button to press. See each mod's README for what to expect and how to configure it.

## Adding a new mod

1. Create a sibling folder under `cc-mods/`:

   ```
   cc-mods/
   └── my-new-mod/
       ├── .claude-plugin/plugin.json
       ├── hooks/hooks.json
       └── hooks/register.mjs
   ```

   (TypeScript hooks are fine too — name it `register.ts` / `register.tsx` and update `hooks/hooks.json` accordingly. This repo uses `.tsx` for `cc-code-format-mod` because its helpers benefit from `EngineInterface` typing.)

   Run `claude plugin validate ./my-new-mod` while building to catch schema errors early.

2. Append an entry to `.claude-plugin/marketplace.json`:

   ```json
   {
     "plugins": [
       {
         "name": "cc-context-mod",
         "source": "./cc-context-mod",
         "description": "..."
       },
       { "name": "my-new-mod", "source": "./my-new-mod", "description": "..." }
     ]
   }
   ```

3. Install:

   ```bash
   claude plugin install my-new-mod@cc-mods --scope user
   ```

4. Add a row to the **Mods** table at the top of this README.

## Develop

Since `claude plugin list` reports the mod as `Read from: .../cc-mods/<mod-name>`, the workflow is:

1. Edit any file under `cc-mods/<mod-name>/`.
2. End the current turn — Claude Code reloads the mod automatically.
3. Run `claude plugin validate ./<mod-name>` after non-trivial changes to catch hook / API drift early.

If the engine refuses to draw what your `ui.render` hook returned, the transcript says so in a dim line, with the reason. With `claude --debug` the same line plus the full error go to the debug log. With a test file (`<mod-name>/hooks/*.test.ts`), `claude plugin test ./<mod-name>` runs each test as the engine does, on each surface.

## Recipes

### Multiple mods sharing `AbovePrompt`

`AbovePrompt` is the single band directly above the prompt input. Every
mod's `on('ui.render', { component: 'AbovePrompt' }, ...)` handler
contributes a row, but the engine picks the **last-returned** tree —
whatever your handler returns _replaces_ whatever earlier mods drew. If
your mod is registered before `cc-context-mod`, `cc-context-mod`'s band
will be replaced by yours (and vice versa). To render **both** bands at
the same time, the engine docs (`code.claude.com/docs/<lang>/plugins/mods/interface`)
say:

> The tree replaces what mods after yours draw. To preserve their output,
> place the result of `await next(e)` among the children of a Box in
> your tree.

In `cc-file-history-mod` the handler does exactly this:

```ts
on("ui.render", { component: "AbovePrompt" }, async ($, e, next) => {
  const { Box } = $.ui.resolve(e);
  const ourBand = renderBand($, e);
  if (ourBand === null) return await next(e); // nothing to add; yield
  let others: unknown = null;
  try {
    others = await next(e);
  } catch {
    others = null;
  } // engine throws if alone
  const looksLikeElement =
    others &&
    typeof others === "object" &&
    typeof (others as any).type === "string";
  if (!looksLikeElement) return ourBand; // no other band; just ours
  return Box({
    // compose both in a column
    flexDirection: "column",
    children: [others, ourBand],
  });
});
```

Live with both `cc-context-mod` and `cc-file-history-mod` loaded:
`cc-context-mod`'s band sits on top, `▶ File history: N edits …` sits
below it; both visible together after every Edit.

Layout rules that bit earlier builds — keep the band's own row plain
(no `flexWrap`, no `flexGrow: 1` spacers, no nested Boxes inside the
row itself). Reach for `flexWrap` only after you have more than one
Text child per row to fit, and only after testing with `cc-context-mod`
loaded.

If your mod doesn't need its own row (e.g. only context-mod-style
display), just return `await next(e)` from the AbovePrompt handler and
let the next plugin in the chain handle everything.

## Publishing

To share this marketplace with another computer:

```bash
cd <path-to-your-cc-mods-clone>
gh repo create cc-mods --public --source=. --push
```

Then on the other machine:

```bash
git clone https://github.com/<owner>/cc-mods
claude plugin marketplace add ./cc-mods
claude plugin install cc-context-mod@cc-mods --scope user
```

The marketplace manifest lives at `.claude-plugin/marketplace.json`; Claude Code discovers it from any clone.

## Layout

```
cc-mods/
├── .claude-plugin/marketplace.json     # one object: { name, owner, metadata, plugins: [] }
├── cc-context-mod/                     # one mod per folder
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json
│   ├── hooks/register.mjs              # register(on, options) { ... }
│   ├── README.md                       # mod-specific docs only (no install/distribute)
│   └── .gitignore                      # excludes Claude Code's auto-gen types/ and tsconfig.json
├── LICENSE
└── README.md                           # this file
```

See [`claude code mod`](https://code.claude.com/docs/zh-CN/plugins/mods/overview) for a deeper instruction.
