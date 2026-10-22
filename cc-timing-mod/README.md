# cc-timing-mod

Answers the question the transcript never answers: **why did that turn take so long?**

Claude Code can sit and work for minutes. The transcript tells you *what* it
did; it never tells you *where the time went*. This mod measures every turn
and splits its wall-clock time into the buckets that explain a slow one.

```
⏱ last turn: 1m 12s · model 48.2s · tools 18.1s · approval 5.0s · hooks 2.3s
```

## The buckets

| Bucket       | What it is                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------- |
| **model**    | The model requests: from the request going out to the response's last chunk. Time to first token and generation time. |
| **tools**    | The tool calls the engine ran. Calls that ran in parallel are counted once. The row breaks it down into the tool's own execution time and the **overhead** around it — the permission check, the result, the transcript. |
| **approval** | The time **you** spent approving a tool call — usually the biggest hidden cost of a long turn.      |
| **hooks**    | What other plugins' hooks added. A breakdown of the buckets above, not a bucket of its own.         |
| **other**    | Whatever is left: the engine's own overhead between the model answering and the tool running.        |

`model + tools + approval + other` adds up to the turn's wall clock.

A tool whose dispatch took 2.2s while the command itself ran for 270ms is
the shape of a surprising slowdown, and the pane says so:

```
tools      2.2s    1 call · exec 270ms · 1.9s overhead
```

## Surfaces

### AbovePrompt band

A live one-line summary of the running turn (and of the last turn once it
ends), with a **Details** button:

```
⏱ turn: 42.1s · model 30.4s · tools 9.2s
```

It ticks once a second while a turn runs, and yields the band to other mods
when there is nothing to show.

### Pane — `/timing`

One block per turn, newest first. The summary is always visible; **Details**
expands the turn into every model request and every tool call:

```
▼ #2  1m 12s  14:32:05  find the bug in the parser
     model     48.2s     4 requests
     tools     18.1s     5 calls
     approval   5.0s     waiting for you
     hooks      2.3s     cc-code-format-mod 1.8s
     other      3.4s     engine overhead
     tokens     in 1.2k   out 3.4k · cached 120k
     requests
     #0  12.4s  ttfb 0.9s  test-model  in 1.1k · out 800 · 1 tool call(s)
     tool calls
     Bash  12.0s  exec 12.0s
     Edit   0.8s  exec 0.8s  approval 5.0s
```

The pane's **Clear** button empties the timeline.

### Toast

A turn slower than `slowTurnSeconds` (default 30) raises a toast naming the
buckets, so a slow turn announces itself when you were looking elsewhere.

## How the numbers are measured

- **model** — a `turn.step` hook wraps the engine's model request: the clock
  runs from the request going out to the response's last chunk, and the time
  to the first chunk is the time to first token. The request's token counts
  come from the response's own usage.
- **tools** — a `tool.call` hook wraps each call's dispatch, from the call to
  its result.
- **hooks** — after the dispatch settles, `next.trace` lists every link that
  ran beneath the profiler: one entry per plugin's hook, each with its own
  wall time. The engine's own entry is the tool's execution; the rest are
  added up per plugin. This is how a slow hook in *another* mod shows up.
- **approval** — `classic.PermissionRequest` marks when the prompt was
  raised, `classic.PreToolUse` / `classic.PostToolUse` mark when the
  approved call got to run. The gap between them is the wait.
- **other** — the turn's wall clock minus everything above.

## Configuration

| Option             | Type   | Default | Meaning                                              |
| ------------------ | ------ | ------- | ---------------------------------------------------- |
| `slowTurnSeconds`  | number | `30`    | A turn slower than this raises a toast. `0` = off.    |

## Install

This mod lives in the `cc-mods` marketplace. See the [repo README](../README.md)
for the install lines.

```
claude plugin install cc-timing-mod@cc-mods --scope user
```

or, for development, load it in place:

```
CLAUDE_CODE_PLUGIN_DIRS=/path/to/cc-mods/cc-timing-mod claude
```

## Notes and limits

- The buckets are measurements, not estimates of the engine's internals. The
  `other` bucket is where anything the profiler cannot see lands — the
  engine's own overhead, compaction, MCP handshakes.
- Approval waits are only visible when the engine raises the classic
  `PermissionRequest` event. In permission modes that never ask, the bucket
  stays at zero — correctly.
- The session keeps the last 30 turns. A hot reload of the mod keeps them:
  the timeline lives in `$.state`, not in the module.
- The profiler never changes what the session does. Every measurement is
  wrapped so that a failure to record a number can never fail a tool call.
- Under an organization that manages Claude Code, the `classic.*` events pass
  over installed plugins — the approval bucket stays empty there, everything
  else still works.
