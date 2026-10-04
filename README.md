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

| Mod                                          | What it does                                                                                                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`cc-context-mod`](./cc-context-mod)         | One-line dashboard above the prompt: context window weather (left) + MiniMax M Plan / Token Plan balance (right).                                                      |
| [`cc-code-format-mod`](./cc-code-format-mod) | Reformats every fenced code block in an LLM response to the language's standard style (Prettier, black, gofmt, rustfmt, shfmt) before the row lands in the transcript. |
| [`cc-notify-mod`](./cc-notify-mod)           | Forwards `turn.complete` / repeated `Bash` failures / `AskUserQuestion` prompts to the macOS Notification Center when you are away from the terminal.                  |

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

## Publishing

To share this marketplace with another computer:

```bash
cd /Users/lixinghui/Documents/code/fe/testground/cc-mods
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
