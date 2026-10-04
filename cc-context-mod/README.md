# cc-context-mod

A one-line dashboard in Claude Code's band above the prompt:

1. **Context window weather** — a forecast of how full the conversation's context is, with a chart of the last 12 turns.
2. **MiniMax M Plan / Token Plan balance** — the 5-hour and 7-day usage windows, fetched live from `GET /v1/token_plan/remains`.

```
☂  Showers  67% of context  134.4k / 200k   last turns ▁▂█  ▲ +98.3k last turn  │  M Plan  5h 93% left (resets 06:40)  •  7d 99% left (resets Wed)
```

The forecast is real (read from `$.session.usage()`, the same figures the status line shows). The M Plan balance is real (called every 60s with your Subscription Key). Both are free — `$.session.usage()` is free, and the M Plan endpoint does not count against usage.

For install / marketplace / hot-reload setup, see the [parent marketplace README](../README.md).

---

## Configure

### Subscription Key (required for M Plan)

The M Plan side reads `GET /v1/token_plan/remains`, which MiniMax only accepts with a **Subscription Key**. A pay-as-you-go API Key returns `login fail` on this endpoint.

Since MiniMax exposes an Anthropic-compatible API, the key you already use for Claude Code (`ANTHROPIC_API_KEY`) is the same Subscription Key — and the mod reads it first:

```bash
export ANTHROPIC_API_KEY="eyJhbGciOi..."
```

Or, if you'd rather keep it under a dedicated name:

```bash
export MINIMAX_SUBSCRIPTION_KEY="eyJhbGciOi..."
```

The mod falls back to `MINIMAX_SUBSCRIPTION_KEY` if `ANTHROPIC_API_KEY` is unset.

Put either in your shell profile (`~/.zshrc`, `~/.bashrc`) so it survives restarts, or in `~/.claude/settings.json` under `env`:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": "eyJhbGciOi..."
  }
}
```

⚠️ Put secrets in `~/.claude/settings.json` (user-level), **not** `.claude/settings.json` (project-level) — the latter can end up in git.

Without either key, the band reads `M Plan: set $ANTHROPIC_API_KEY (or $MINIMAX_SUBSCRIPTION_KEY)`, in dim grey, so it's obvious what to do.

### API host (optional, defaults to China)

The mod defaults to `https://api.minimaxi.com` (the China host). International accounts override via the `baseUrl` user field, set either through the config menu or directly in `~/.claude/settings.json`:

```json
{
  "pluginConfigs": {
    "cc-context-mod": { "baseUrl": "https://api.minimax.io" }
  }
}
```

---

## What you see

### Context forecast (left)

| Used      | Forecast        |
|-----------|----------------|
| under 25% | ☀ Clear        |
| 25–49%    | ☁ Cloudy       |
| 50–74%    | ☂ Showers      |
| 75–89%    | ☇ Storm        |
| 90% up    | ↯ Compact soon |

The chart (▁▂▃▄▅▆▇█) shows the last 12 turns, scaled to the busiest one. `▲ +98.3k last turn` is how much the last turn added.

### M Plan / Token Plan (right)

Two windows, each as percent remaining:

```
M Plan  5h 93% left (resets 06:40)  •  7d 99% left (resets Wed)
```

The mod picks the `general` bucket from the API's `model_remains[]` array — that's where text models (including `MiniMax-M3`) live; the `video` bucket is separate. Reset times are local within 24 hours, weekday when longer.

Error states, all visible in the band:

| Band shows              | Means                                                     |
|-------------------------|-----------------------------------------------------------|
| `M Plan: HTTP 401`      | Bad / missing Subscription Key                            |
| `M Plan: ECONNRESET`    | Wrong host — switch `baseUrl` (international vs. China)   |
| `M Plan: login fail…`   | Subscription Key wrong, or pay-as-you-go key on this endpoint |
| `M Plan: empty response`| API returned nothing parseable                            |
| `M Plan —`              | No fetch yet (right after `session.start`)                |

### Layout at narrow terminals

Each "section" is its own Box; the outer Box has `flexWrap: 'wrap'` so a section that doesn't fit moves cleanly to the next line. Thresholds:

| Width  | What's shown                                              |
|--------|-----------------------------------------------------------|
| ≥ 100  | forecast + chart + trend + M Plan with reset times         |
| ≥ 90   | forecast + M Plan with reset times (no chart)              |
| ≥ 55   | forecast + M Plan (no reset times, no chart)               |
| < 55   | forecast only                                             |

---

## How it works

| Hook           | What it does                                                        |
|----------------|--------------------------------------------------------------------|
| `session.start`| First context reading, first balance fetch, starts a 60s timer.    |
| `turn.complete`| Takes a context reading after each main-loop turn. Subagent turns are skipped. |
| `ui.render` with `{component: "AbovePrompt"}` | Draws the band.                       |
| `$.clock.every(60000, …)` | Re-fetches the balance so the windows stay current between turns. |

The context reading is `$.session.usage()` — free, no breakdown. The balance reading is `$.http.fetch('${baseUrl}/v1/token_plan/remains', { headers: { Authorization: Bearer ${key} } })`. Rate-limited by a 30s minimum gap inside the module, on top of the 60s timer, so a burst of turns won't hammer the API.

Module state (history, latest reading) lives in module-level vars, exactly like `token-weather`. Both reset on session start and on hot reload — `token-weather`'s README explains why this is fine.

---

## Limitations

- Context updates after each turn, not during. The 60s balance timer covers the in-between.
- The chart's bars are relative to the busiest reading shown. M Plan percentages are absolute.
- One band per session — another plugin that draws `AbovePrompt` competes for the same row.
- The M Plan side calls `$.http.fetch`, which `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` may block. With that variable set the band shows an HTTP error.
- Picks the `general` bucket only. Per-model breakdown (`model_remains[]` has `general` + `video`) is parsed and dropped — open an issue if you want it.

---

## Inspiration

- [`anthropics/claude-code-playground/mods/token-weather`](https://github.com/anthropics/claude-code-playground/tree/main/claude-code/mods/token-weather) — context forecast patterns, single-row mod layout, state-reset-on-reload rationale.
- M Plan / Token Plan endpoint: [`platform.minimax.io/docs/m-plan/faq`](https://platform.minimax.io/docs/m-plan/faq), [`minimax-token-plan-api.md`](https://github.com/me-speaker/token_manager/blob/master/minimax-token-plan-api.md).
- Mod API: [`code.claude.com/docs/en/settings`](https://code.claude.com/docs/en/settings) and the in-process declaration at `.claude-plugin/types/claude-code/index.d.ts` (after the first load).