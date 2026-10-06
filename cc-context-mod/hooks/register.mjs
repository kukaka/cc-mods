// Copyright 2026
// SPDX-License-Identifier: Apache-2.0
//
// cc-context-mod: a live forecast of the context window on the left,
// and MiniMax M Plan / Token Plan balance on the right.
//
// Context window: session.measure's e.context (free) on the main trigger,
// $.session.usage().context (also free) as fallback for the other hooks.
// M Plan balance: GET /v1/token_plan/remains on the host, every 60s,
// with the Subscription Key from $MINIMAX_SUBSCRIPTION_KEY.
//
// session.measure (primary): the engine pushes usage figures here whenever
//   they move — after each main-thread turn and when rate-limit windows
//   move. e.context carries { tokens, window, percent } directly, so we
//   don't need to poll $.session.usage() on every fire. Gate on
//   e.changed.includes('context') so we don't churn when only rateLimits
//   moved.
// session.compact: catches /compact and autocompact (and /rewind's
//   "Summarize from here/up to here", which is the same engine path),
//   where session.measure does not necessarily push a new measurement
//   (the boundary notice lands as a session.append, but the conversation
//   is just shorter now — no guarantee the engine remeasures). The
//   result of next(e) is SessionCompacted with the engine's own
//   tokensAfter, used as the post-compact reading; precompute runs omit
//   tokensAfter, so we fall back to readUsage($) for those. The
//   !e.agentId filter skips subagent compactions — they don't move the
//   main window.
// session.end { reason: 'clear' | 'resume' }: catches the cases that
//   end one conversation and start another in the same process without
//   firing session.start for it: /clear (and aliases /reset, /new),
//   /resume, --resume, --continue, /branch. Without this hook the
//   chart, balance and lastFetchAt keep their old-session values until
//   the next turn — the band shows the prior percentage and stale bars
//   until session.measure / session.append finally push. We mirror the
//   session.start reset (history → empty, balance → null, fetch gap →
//   0, then a pending placeholder — no readUsage here, see the hook)
//   so the band reads as fresh the instant the engine hands control
//   back. Other reasons (prompt_input_exit / logout / other) mean the
//   process itself is leaving — module state goes with it, no reset
//   needed. The 60s balance timer is already running from
//   session.start and stays running across these.
// session.append { door: 'tool-result' | 'response' } (main loop only):
//   catches intra-turn context growth that session.measure might not push
//   for. A tool_result that lands in the parent's transcript (including a
//   subagent's return) bumps the parent's context before the next model
//   call; each new model response brings back input_tokens for what it
//   just answered over. The !e.agentId filter drops subagent-internal
//   rows — they don't move the parent's $.session.usage().
// turn.complete: safety net for subagent turns and any case
//   session.measure / session.compact / session.append / session.end miss.
// session.start: first reading, first balance fetch, starts a 60s timer.
// ui.render (AbovePrompt): one band — context weather on the left, the
//   5h and 7d M Plan windows on the right, separated by a divider.
//
// readUsage dedupes against the last real reading: when multiple hooks
// report the same tokens+window (e.g. session.measure and turn.complete
// both firing at turn end), only one bar is appended to the chart. The
// seeded { pending: true } placeholder from session.start (and
// session.end on /clear or /resume) is dropped inside readUsage once
// any hook pushes the first real reading.

const HISTORY = 12;
const REFRESH_MS = 60_000;        // poll the balance API every 60s
const REFRESH_MIN_GAP_MS = 30_000; // but no more than once per 30s
const BARS = "▁▂▃▄▅▆▇█";

// Forecast bands by percent of context window used.
const FORECAST = [
  { upTo: 25, icon: "☀", word: "Clear", color: "yellow" },
  { upTo: 50, icon: "☁", word: "Cloudy", color: "cyan" },
  { upTo: 75, icon: "☂", word: "Showers", color: "blue" },
  { upTo: 90, icon: "☇", word: "Storm", color: "magenta" },
  { upTo: Infinity, icon: "↯", word: "Compact soon", color: "red" },
];

const DEFAULT_BASE_URL = "https://api.minimaxi.com";

// State — resets when the module reloads.
let readings = [];
// { status: 'ok' | 'error' | 'no-key', interval, weekly, message?, fetchedAt }
let balance = null;
let lastFetchAt = 0;

export function register(on, options) {
  const rawBase = typeof options?.baseUrl === "string" ? options.baseUrl.trim() : "";
  const baseUrl = rawBase ? rawBase.replace(/\/+$/, "") : DEFAULT_BASE_URL;

  on("session.start", async ($, e, next) => {
    const result = await next(e);
    readings = [];
    balance = null;
    lastFetchAt = 0;
    await readUsage($);
    // If readUsage had no real numbers to record (common on a fresh
    // session — $.session.usage() returns 0 before the first response),
    // seed a "pending" reading so the band can render immediately with a
    // "—  / 1M" placeholder. Real data replaces it as soon as
    // turn.complete records a real reading.
    if (readings.length === 0) {
      readings.push({ pending: true });
    }
    $.ui.invalidate("ui.render");
    await refreshBalance($, baseUrl);
    startRefresh($, baseUrl);
    return result;
  });

  on("session.measure", async ($, e, next) => {
    // Engine pushes figures here whenever a unit moved. Use the context
    // it carried directly — no need to re-poll $.session.usage().
    if (e.changed.includes("context")) {
      await readUsage($, e.context);
    }
    return next(e);
  });

  on("session.compact", async ($, e, next) => {
    // Runs around /compact, autocompact, or a plugin's $.session.compact()
    // call. After next(e) the engine has installed the summary and the
    // kept messages; the result is SessionCompacted with the engine's own
    // tokensAfter (the freshest context figure we have here — session.measure
    // does not necessarily push a new measurement after a compaction).
    // Subagent compactions (e.agentId set) don't move the main window,
    // so they get the same skip as session.append's main-loop filter.
    const result = await next(e);
    if (!e.agentId && result && !result.skip) {
      if (Number.isFinite(result.tokensAfter) && result.tokensAfter > 0) {
        // Merge tokensAfter with the session's window — $.session.usage()
        // already reflects the post-compact state here. The combined
        // record clears the dedupe in readUsage so the drop shows up in
        // the chart instead of being silently skipped.
        try {
          const usage = await $.session.usage();
          if (usage?.context?.window > 0) {
            await readUsage($, {
              tokens: result.tokensAfter,
              window: usage.context.window,
              percent: (result.tokensAfter / usage.context.window) * 100,
            });
            return result;
          }
        } catch {
          // Fall through to readUsage($).
        }
      }
      // Precompute runs and any case where the engine didn't record
      // tokensAfter: readUsage($) reads from $.session.usage(), which the
      // engine keeps up to date.
      await readUsage($);
    }
    return result;
  });

  on("session.end", async ($, e, next) => {
    // /clear, /reset, /new → reason 'clear': the conversation ends, the
    // process goes on under a fresh session id, and (per the engine docs)
    // no session.start fires for it. /resume, --resume, --continue,
    // /branch → reason 'resume': another session takes its place in the
    // same process. In both cases the plugin stays loaded but its
    // module-level state (history, latest reading, last balance fetch)
    // is from the old session and would otherwise stick in the band —
    // session.measure on the new session's first turn eventually pushes
    // the right number, but until then the chart shows stale bars and
    // the balance reflects the old session's fetch gap. Mirror the
    // session.start reset so the band reads as fresh the moment the
    // engine hands control back. prompt_input_exit / logout / other all
    // mean the process itself is leaving — module state goes with it,
    // no reset needed.
    const result = await next(e);
    if (e.reason === "clear" || e.reason === "resume") {
      readings = [];
      balance = null;
      lastFetchAt = 0;
      // Don't call readUsage($) here. Right after next(e) the engine is
      // mid-handoff between sessions: $.session.usage() may still
      // answer with the *old* session's figures, which we'd then record
      // as the new reading and the band would keep showing the prior
      // percentage. Skipping readUsage and seeding the pending
      // placeholder is safe — the first session.measure / session.append
      // / turn.complete on the new session drops the placeholder and
      // records the real value, the same shape session.start falls back
      // to before its first response.
      readings.push({ pending: true });
      $.ui.invalidate("ui.render");
      await refreshBalance($, baseUrl);
    }
    return result;
  });

  on("session.append", { door: "tool-result" }, async ($, e, next) => {
    // A tool_result just landed in the transcript. Main loop only:
    // subagent-internal tool_results carry agentId and don't move
    // $.session.usage() (which always returns the main session's window).
    // This is where subagent returns and big tool outputs show up between
    // model calls — before session.measure has a chance to push.
    if (!e.agentId) {
      await readUsage($);
    }
    return next(e);
  });

  on("session.append", { door: "response" }, async ($, e, next) => {
    // A model response just landed. The new input_tokens for that
    // response is the freshest context figure available; $.session.usage()
    // should reflect it. Main loop only.
    if (!e.agentId) {
      await readUsage($);
    }
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    // Safety net: covers subagent turns (where session.measure is
    // documented as main-thread only) and any case session.measure /
    // session.compact / session.append / session.end missed. Dedup in
    // readUsage keeps this from bloating the chart when the same value
    // arrives from multiple hooks.
    await readUsage($);
    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (e.hasSurvey) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return band(Box, Text, e.bodyColumns ?? 80);
  });
}

async function readUsage($, ctx = null) {
  let tokens, window, percent;
  if (ctx) {
    // session.measure hands us the figure directly — no $.session.usage() call.
    ({ tokens, window, percent } = ctx);
  } else {
    try {
      const usage = await $.session.usage();
      if (!usage || !usage.context || !usage.context.window) return false;
      tokens = usage.context.tokens;
      window = usage.context.window;
      percent = usage.context.percent;
    } catch {
      // Keep the previous reading.
      return false;
    }
  }
  // Skip zero / placeholder readings: a fresh session reads 0 before the
  // first response, and seeding a 0 here would leave the band stuck at
  // "0% of context" until the first real hook fires. The band shows a
  // "—  / 1M" placeholder via the `pending` reading seeded in
  // session.start, until a real reading arrives.
  if (
    !Number.isFinite(tokens) ||
    tokens <= 0 ||
    !Number.isFinite(window) ||
    window <= 0
  ) {
    return false;
  }
  // Dedupe against the last real reading: same tokens+window means no
  // movement, so multiple hooks reporting the same state (e.g. session.measure
  // and turn.complete both firing at turn end) don't bloat the chart.
  const last = readings[readings.length - 1];
  if (
    last &&
    !last.pending &&
    last.tokens === tokens &&
    last.window === window
  ) {
    return false;
  }
  const finalPercent = Math.round(percent ?? (tokens / window) * 100);
  readings.push({ tokens, window, percent: finalPercent });
  // Drop the seeded "pending" placeholder once a real reading arrives,
  // regardless of which hook supplied it — so the chart and trend are
  // computed from real data only.
  if (readings[0]?.pending && readings.length > 1) {
    readings.shift();
  }
  if (readings.length > HISTORY) readings = readings.slice(-HISTORY);
  $.ui.invalidate("ui.render");
  return true;
}

let timer = null;
function startRefresh($, baseUrl) {
  if (timer) return;
  // The engine drops timers when the module reloads.
  timer = $.clock.every(REFRESH_MS, async () => {
    await refreshBalance($, baseUrl);
  });
}

async function refreshBalance($, baseUrl) {
  const now = Date.now();
  if (now - lastFetchAt < REFRESH_MIN_GAP_MS) return;
  lastFetchAt = now;

  // $.env.get requires a string literal, so the env var names are spelled here.
  // MiniMax M Plan is Anthropic-compatible, so the same key Claude Code uses
  // for chat (ANTHROPIC_API_KEY, set to the Subscription Key) also works for
  // /v1/token_plan/remains. The dedicated name is the explicit override.
  let subscriptionKey = await $.env.get("ANTHROPIC_API_KEY");
  if (!subscriptionKey) {
    subscriptionKey = await $.env.get("MINIMAX_SUBSCRIPTION_KEY");
  }
  if (!subscriptionKey) {
    balance = {
      status: "no-key",
      message: "set $ANTHROPIC_API_KEY (or $MINIMAX_SUBSCRIPTION_KEY)",
      fetchedAt: now,
    };
    $.ui.invalidate("ui.render");
    return;
  }

  try {
    const { ok, status, text } = await $.http.fetch(
      `${baseUrl}/v1/token_plan/remains`,
      {
        method: "GET",
        headers: {
          Authorization: `Bearer ${subscriptionKey}`,
          "Content-Type": "application/json",
        },
      }
    );
    if (!ok) {
      balance = { status: "error", message: `HTTP ${status}`, fetchedAt: now };
      $.ui.invalidate("ui.render");
      return;
    }
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error("invalid JSON");
    }
    balance = { ...parseBalance(body), fetchedAt: now };
  } catch (err) {
    balance = {
      status: "error",
      message: String(err?.message ?? err),
      fetchedAt: now,
    };
  }
  $.ui.invalidate("ui.render");
}

function parseBalance(body) {
  if (!body || typeof body !== "object") {
    return { status: "error", message: "empty response" };
  }
  // MiniMax error responses wrap in base_resp; success wraps in model_remains[].
  if (body.base_resp && typeof body.base_resp === "object") {
    const code = body.base_resp.status_code;
    if (code && code !== 0) {
      return {
        status: "error",
        message: body.base_resp.status_msg ?? `code ${code}`,
      };
    }
  }
  const items = Array.isArray(body.model_remains) ? body.model_remains : [];
  if (items.length === 0) {
    return { status: "error", message: "no model_remains" };
  }
  // Pick the text bucket; fall back to the first entry.
  const general =
    items.find((m) => m && m.model_name === "general") ?? items[0];

  return {
    status: "ok",
    model: general.model_name,
    interval: {
      percent: general.current_interval_remaining_percent ?? null,
      reset: msToIso(general.end_time),
    },
    weekly: {
      percent: general.current_weekly_remaining_percent ?? null,
      reset: msToIso(general.weekly_end_time),
    },
  };
}

function msToIso(ms) {
  if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

// --- drawing ---------------------------------------------------------------

function band(Box, Text, columns) {
  // The latest reading is "usable" only when we have real numbers. Before
  // the first turn completes, session.start seeded a `{ pending: true }`
  // reading so the band can render immediately with a placeholder instead
  // of being absent.
  const now = readings[readings.length - 1];
  const hasData = !!now && !now.pending && Number.isFinite(now.tokens) && now.tokens > 0;
  const ctx = hasData ? forecastFor(now.percent) : null;
  const trend = hasData ? trendWord() : "";

  // Width-based layout decisions. The chart is always shown once we have
  // real data — the user asked for it visible regardless of terminal width.
  const showChart = hasData;
  const showResets = columns >= 90;
  const showMPlan = columns >= 55;

  // Each section is its own row-Box; the outer Box wraps whole sections,
  // so a section that doesn't fit moves cleanly to the next line.
  const sections = [];

  // Section 1: forecast (always shown).
  // No-data placeholder mirrors the real data shape (icon + word +
  // "X% of context" + "X / Y") so the band stays the same width when the
  // first reading arrives — just switches from dim placeholders to real
  // values. Default forecast is Clear (the band a 0-token reading lands in).
  const placeholder = forecastFor(0);
  sections.push(
    Box({
      flexDirection: "row",
      children: hasData
        ? [
            Text({ color: ctx.color, bold: true, children: `${ctx.icon}  ${ctx.word}` }),
            Text({ children: `  ${now.percent}% of context` }),
            Text({
              dimColor: true,
              children: `  ${short(now.tokens)} / ${short(now.window)}`,
            }),
          ]
        : [
            Text({ dimColor: true, children: `${placeholder.icon}  ${placeholder.word}` }),
            Text({ dimColor: true, children: "  —% of context" }),
            Text({ dimColor: true, children: "  —  / 1M" }),
          ],
    })
  );

  // Section 2: chart of recent turns + trend (only on wide terminals, and
  // only once we have at least one real reading — chart/trend are nonsense
  // off a single placeholder).
  if (showChart && hasData) {
    const chartChildren = [
      Text({ dimColor: true, children: "   last turns " }),
      Text({ color: ctx.color, children: chart() }),
    ];
    if (trend) {
      chartChildren.push(Text({ dimColor: true, children: `  ${trend}` }));
    }
    sections.push(Box({ flexDirection: "row", children: chartChildren }));
  }

  // Section 3: M Plan balance, with reset times if there's room.
  if (showMPlan) {
    const planChildren = planTexts(Text, showResets);
    planChildren.unshift(Text({ dimColor: true, children: "  │  " }));
    sections.push(Box({ flexDirection: "row", children: planChildren }));
  }

  return Box({
    flexDirection: "row",
    flexWrap: "wrap",
    paddingX: 1,
    children: sections,
  });
}

function planTexts(Text, showResets = true) {
  if (!balance) {
    return [Text({ dimColor: true, children: "M Plan —" })];
  }
  if (balance.status === "error") {
    return [Text({ color: "red", children: `M Plan: ${balance.message}` })];
  }
  if (balance.status === "no-key") {
    return [Text({ dimColor: true, children: `M Plan: ${balance.message}` })];
  }

  const parts = [Text({ color: "magenta", bold: true, children: "M Plan" })];
  const haveInterval = balance.interval.percent != null;
  const haveWeekly = balance.weekly.percent != null;

  if (haveInterval) {
    parts.push(
      Text({ children: `  5h ${balance.interval.percent}% left` })
    );
    if (showResets && balance.interval.reset) {
      parts.push(
        Text({ dimColor: true, children: ` (resets ${formatReset(balance.interval.reset)})` })
      );
    }
  }

  if (haveInterval && haveWeekly) {
    parts.push(Text({ dimColor: true, children: "  •" }));
  }

  if (haveWeekly) {
    parts.push(
      Text({ children: `  7d ${balance.weekly.percent}% left` })
    );
    if (showResets && balance.weekly.reset) {
      parts.push(
        Text({ dimColor: true, children: ` (resets ${formatReset(balance.weekly.reset)})` })
      );
    }
  }

  if (!haveInterval && !haveWeekly) {
    parts.push(Text({ dimColor: true, children: " —" }));
  }

  return parts;
}

function formatReset(iso) {
  const t = new Date(iso).getTime();
  if (!isFinite(t)) return "";
  const deltaH = (t - Date.now()) / 3_600_000;
  const d = new Date(t);
  if (deltaH > 24) {
    return d.toLocaleDateString(undefined, { weekday: "short" });
  }
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function forecastFor(percent) {
  return FORECAST.find((b) => percent < b.upTo) ?? FORECAST[FORECAST.length - 1];
}

// Bars scale to the busiest reading shown, so growth shows at any fill level.
function chart() {
  const real = readings.filter((r) => !r.pending);
  if (real.length === 0) return "";
  const top = Math.max(...real.map((r) => r.tokens), 1);
  return real
    .map((r) =>
      BARS[Math.min(BARS.length - 1, Math.floor((r.tokens / top) * (BARS.length - 1)))]
    )
    .join("");
}

function trendWord() {
  const real = readings.filter((r) => !r.pending);
  if (real.length < 2) return "";
  const delta = real[real.length - 1].tokens - real[real.length - 2].tokens;
  if (delta > 0) return `▲ +${short(delta)} last turn`;
  if (delta < 0) return `▼ ${short(-delta)} last turn`;
  return "steady";
}

function short(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}