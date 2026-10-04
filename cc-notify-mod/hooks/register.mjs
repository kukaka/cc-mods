// Copyright 2026
// SPDX-License-Identifier: Apache-2.0
//
// cc-notify-mod: forward Claude Code lifecycle events to the macOS
// Notification Center so the user hears about them when they are away
// from the terminal.
//
// Three event sources, three notification levels:
//
//   turn.complete (not aborted) -> info
//     subtitle "[Task Complete]"  body "<first sentence of answer>"
//   Bash failed retryCount times  -> warn
//     subtitle "[Bash failed N×]" body "<short error>"
//   AskUserQuestion rendered     -> important
//     subtitle "[Claude is asking]" body "<question>"
//
// All three are suppressed when the terminal is the frontmost app
// (suppressWhenFocused) and when the turn finished too quickly
// (suppressIfUnderMs). The full configuration is documented in README.md.

const SUPPRESS_IF_UNDER_MS = 5_000;
const RETRY_COUNT = 3;
const RETRY_RESET_MS = 60_000;
const RETRY_GC_MS = 5 * RETRY_RESET_MS;
const MAX_RETRY_ENTRIES = 64;

// macOS apps that mean "the user is looking at the terminal running Claude".
// Comparison is case-sensitive against the exact `name of first application
// process whose frontmost is true` string from System Events. Add your own
// terminal to this list by editing register.mjs.
const FOCUSED_NAMES = new Set([
  "Terminal",
  "iTerm2",
  "iTerm",
  "Warp",
  "Alacritty",
  "kitty",
  "Kitty",
  "Hyper",
  "WezTerm",
  "Ghostty",
  "Claude",
]);

// Built-in macOS notification sounds. See `man say` or System Settings >
// Sound > Sound Effects for the full list.
const DEFAULT_SOUNDS = {
  info: "Glass",
  warn: "Basso",
  important: "Frog",
};

// State — resets on module reload.
let enabled = true;
let suppressWhenFocused = true;
let stickyOnError = false;
let sounds = { ...DEFAULT_SOUNDS };
let lastTurnStartedAt = 0;
// Cached result of the last osascript foreground-app probe. Shared between
// hook calls within a single turn (turn.complete + tool.call +
// AskUserQuestion may all probe in the same turn) so we don't run the
// osascript round trip more than once per 2s.
let lastFocus = null; // "focused" | "away" | "unknown"
let lastFocusCheckedAt = 0;
// sig -> { count, lastAt }
const retries = new Map();
// Probe result for whether osascript is on PATH and runnable. null until
// the first call to osascriptAvailable. The mod has no Node.js APIs (no
// process.platform), so we can't detect the host OS at the JS level — we
// run a one-shot `osascript -e 1` instead.
let osascriptOk = null;

export function register(on, options) {
  // userConfig wiring — only top-level toggles in v1, the rest (sounds,
  // thresholds) live as code constants and can be promoted to userConfig
  // in a later version.
  if (typeof options?.enabled === "boolean") enabled = options.enabled;
  if (typeof options?.suppressWhenFocused === "boolean") {
    suppressWhenFocused = options.suppressWhenFocused;
  }
  if (typeof options?.stickyOnError === "boolean") {
    stickyOnError = options.stickyOnError;
  }

  on("session.start", async ($, e, next) => {
    await resetSessionState($);
    return next(e);
  });

  // `session.start` only fires at the very beginning. /clear, /resume and
  // /branch fire `classic.SessionStart` instead (the setting-hook namespaced
  // event), with `source` set to one of "clear" / "resume" / "fork". Reset
  // the same state on those triggers so the focus cache doesn't carry
  // stale data across a clear and osascriptOk is re-probed cleanly.
  on(
    "classic.SessionStart",
    { source: ["clear", "resume", "fork"] },
    async ($, e, next) => {
      await resetSessionState($);
      return next(e);
    }
  );

  on("turn.start", ($, e, next) => {
    lastTurnStartedAt = Date.now();
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const result = await next(e);
    // Subagent turns: skip — they fire on the same Notifier and would
    // double up with the parent's notification.
    if (e.agentId) return result;
    // Aborted (user interrupted): no notification — they already know.
    if (e.isAborted) return result;

    const durationMs = Date.now() - (lastTurnStartedAt || Date.now());
    const tooShort = durationMs >= 0 && durationMs < SUPPRESS_IF_UNDER_MS;

    if (!tooShort) {
      const focus = await getFocus($);
      if (focus !== "focused") {
        await notify($, {
          level: "info",
          title: "Claude Code",
          subtitle: "[Task Complete]",
          body: summary(e),
        });
      }
    }

    return result;
  });

  on("tool.call", { tool: "Bash" }, async ($, e, next) => {
    const result = await next(e);
    if (!result) return result;

    // success: clear any retry counter for this signature
    if (!result.isError && !result.deny) {
      retries.delete(commandSignature(e));
      return result;
    }

    const sig = commandSignature(e);
    const now = Date.now();
    const existing = retries.get(sig);
    const count = (existing?.count ?? 0) + 1;
    retries.set(sig, { count, lastAt: now });

    // Periodically GC stale entries so the Map doesn't grow unbounded.
    if (retries.size > MAX_RETRY_ENTRIES) {
      for (const [k, v] of retries.entries()) {
        if (now - v.lastAt > RETRY_GC_MS) retries.delete(k);
      }
    }

    if (count < RETRY_COUNT) return result;

    const focus = await getFocus($);
    if (focus === "focused") return result;

    await notify($, {
      level: "warn",
      title: "Claude Code — repeated failure",
      subtitle: `[Bash failed ${count}×]`,
      body: shortError(result),
      sticky: stickyOnError,
    });
    return result;
  });

  on("ui.render", { component: "AskUserQuestion" }, async ($, e, next) => {
    const result = await next(e);
    const focus = await getFocus($);
    if (focus === "focused") return result;
    const question = askQuestionText(e);
    await notify($, {
      level: "important",
      title: "Claude Code",
      subtitle: "[Claude is asking]",
      body: question,
    });
    return result;
  });
}

// --- session lifecycle ----------------------------------------------------

// Reset all per-session state and re-probe the foreground app. Called from
// `session.start` (real session boot) and `classic.SessionStart { source:
// ['clear','resume','fork'] }` (after /clear, /resume, /branch).
async function resetSessionState($) {
  retries.clear();
  lastTurnStartedAt = Date.now();
  lastFocus = null;
  lastFocusCheckedAt = 0;
  osascriptOk = null;
  // Eagerly probe focus so the first turn.complete after startup or
  // /clear has a fresh result rather than a cached one from before the
  // reset.
  await getFocus($);
}

// --- focus detection ------------------------------------------------------

// One-shot probe: runs `osascript -e 1` once and caches whether it succeeded.
// The mod runtime has no Node.js globals (no `process.platform`), so we use
// the probe itself as the host-OS signal: macOS exits 0, every other host
// either rejects (command not found) or exits non-zero. After the first
// call the answer is cached for the lifetime of this module instance.
async function osascriptAvailable($) {
  if (osascriptOk !== null) return osascriptOk;
  try {
    const { exitCode } = await $.process.run(["osascript", "-e", "1"]);
    osascriptOk = exitCode === 0;
  } catch {
    osascriptOk = false;
  }
  return osascriptOk;
}

// Returns "focused" if Claude Code is the frontmost app, "away" otherwise,
// "unknown" if System Events cannot answer. Cached for 2s because the
// osascript round trip is ~50ms and we may call this several times in a
// single turn.
async function getFocus($) {
  if (!suppressWhenFocused) return "away";
  const now = Date.now();
  if (lastFocus !== null && now - lastFocusCheckedAt < 2_000) {
    return lastFocus;
  }
  if (!(await osascriptAvailable($))) {
    lastFocus = "unknown";
    lastFocusCheckedAt = now;
    return lastFocus;
  }
  try {
    const { stdout, exitCode } = await $.process.run([
      "osascript",
      "-e",
      'tell application "System Events" to get name of first application process whose frontmost is true',
    ]);
    if (exitCode !== 0) {
      lastFocus = "unknown";
    } else {
      const name = stdout.trim();
      lastFocus = FOCUSED_NAMES.has(name) ? "focused" : "away";
    }
  } catch {
    lastFocus = "unknown";
  }
  lastFocusCheckedAt = now;
  return lastFocus;
}

// --- system notification --------------------------------------------------

async function notify($, opts) {
  if (!enabled) return;
  if (!(await osascriptAvailable($))) return;
  const { level = "info", title, subtitle, body, sticky } = opts;
  const sound = sounds[level] ?? sounds.info;
  const script = [
    "display notification",
    appleString(body || ""),
    "with title",
    appleString(title),
    "subtitle",
    appleString(subtitle || ""),
    "sound name",
    appleString(sound),
  ].join(" ");
  try {
    await $.process.run(["osascript", "-e", script]);
  } catch {
    // Most common failure: the user has not granted Notification Center
    // permission to osascript. macOS will surface a one-time permission
    // dialog; until they accept, the call rejects silently.
  }
  // stickyOnError is a future feature — osascript's `display notification`
  // has no sticky parameter, and BurntToast / terminal-notifier integration
  // is deferred. Accept the option silently so the config knob is honored
  // by code that already calls notify($, { sticky: true }).
  void sticky;
}

// Escape a string for embedding inside a double-quoted AppleScript literal.
// We only need to handle backslashes and double quotes because we control
// every other character (ASCII body, short titles).
function appleString(s) {
  return '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
}

// --- summaries ------------------------------------------------------------

function summary(e) {
  const text = (e.answer || "").trim();
  if (!text) return "task complete";
  // First line, capped so the notification body stays readable.
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  const cap = 140;
  return firstLine.length > cap ? firstLine.slice(0, cap - 1) + "…" : firstLine;
}

function shortError(result) {
  if (result.deny) return `denied: ${result.deny}`;
  const text = (result.output || result.error || "").toString().trim();
  if (!text) return "no output";
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  const cap = 140;
  return firstLine.length > cap ? firstLine.slice(0, cap - 1) + "…" : firstLine;
}

function askQuestionText(e) {
  // AskUserQuestion props vary by surface; pick whichever is present.
  const props = e.props || {};
  return (
    props.question ||
    props.header ||
    (Array.isArray(props.questions) && props.questions[0]?.question) ||
    "Claude needs your input"
  );
}

// sig = command + cwd so identical commands in different worktrees don't
// share a counter (and accidentally trip the warn threshold).
function commandSignature(e) {
  return `${e.cwd || ""}::${e.command || ""}`;
}
