// Copyright 2026
// SPDX-License-Identifier: Apache-2.0
//
// cc-context-mod: a live forecast of the context window on the left,
// and MiniMax M Plan / Token Plan balance on the right.
//
// Context window: $.session.usage().context after every turn (free).
// M Plan balance: GET /v1/token_plan/remains on the host, every 60s,
// with the Subscription Key from $MINIMAX_SUBSCRIPTION_KEY.
//
// turn.complete / session.start: refresh the context reading.
// session.start: also kick off the first balance fetch and a periodic timer
//   so the M Plan windows stay current between turns.
// ui.render (AbovePrompt): one band — context weather on the left, the
//   5h and 7d M Plan windows on the right, separated by a divider.

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
    await refreshBalance($, baseUrl);
    startRefresh($, baseUrl);
    return result;
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    if (e.agentId) return result;
    await readUsage($);
    return result;
  });

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    if (e.hasSurvey) return next(e);
    if (readings.length === 0) return next(e);
    const { Box, Text } = $.ui.resolve(e);
    return band(Box, Text, e.bodyColumns ?? 80);
  });
}

async function readUsage($) {
  try {
    const usage = await $.session.usage();
    if (!usage || !usage.context || !usage.context.window) return;
    const tokens = usage.context.tokens;
    // Skip zero / placeholder readings: a fresh session reads 0 before the
    // first response, and seeding a 0 here would leave the band stuck at
    // "0% of context" until the first real turn.complete fires (and never
    // clears if the user is just looking at the prompt, or if the first turn
    // happens to be a subagent one we skip). The band renders as soon as a
    // real reading arrives.
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const percent = Math.round(
      usage.context.percent ?? (tokens / usage.context.window) * 100
    );
    readings.push({ tokens, window: usage.context.window, percent });
    if (readings.length > HISTORY) readings = readings.slice(-HISTORY);
    $.ui.invalidate("ui.render");
  } catch {
    // Keep the previous reading.
  }
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
  const now = readings[readings.length - 1];
  const ctx = forecastFor(now.percent);
  const trend = trendWord();

  // Width-based layout decisions.
  const showChart = columns >= 100;
  const showResets = columns >= 90;
  const showMPlan = columns >= 55;

  // Each section is its own row-Box; the outer Box wraps whole sections,
  // so a section that doesn't fit moves cleanly to the next line.
  const sections = [];

  // Section 1: forecast (always shown).
  sections.push(
    Box({
      flexDirection: "row",
      children: [
        Text({ color: ctx.color, bold: true, children: `${ctx.icon}  ${ctx.word}` }),
        Text({ children: `  ${now.percent}% of context` }),
        Text({
          dimColor: true,
          children: `  ${short(now.tokens)} / ${short(now.window)}`,
        }),
      ],
    })
  );

  // Section 2: chart of recent turns + trend (only on wide terminals).
  if (showChart) {
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
  const top = Math.max(...readings.map((r) => r.tokens), 1);
  return readings
    .map((r) =>
      BARS[Math.min(BARS.length - 1, Math.floor((r.tokens / top) * (BARS.length - 1)))]
    )
    .join("");
}

function trendWord() {
  if (readings.length < 2) return "";
  const delta = readings[readings.length - 1].tokens - readings[readings.length - 2].tokens;
  if (delta > 0) return `▲ +${short(delta)} last turn`;
  if (delta < 0) return `▼ ${short(-delta)} last turn`;
  return "steady";
}

function short(n) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}