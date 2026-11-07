# cc-timing-mod

Answers the question the transcript never answers: **why did that turn take so long?**

Claude Code can sit and work for minutes. The transcript tells you *what* it
did; it never tells you *where the time went*. This mod measures every turn
and splits its wall-clock time into the buckets that explain a slow one.

```
▶ Timing: last turn 1m 12s · model 48.2s · tools 18.1s · approval 5.0s · hooks 2.3s
```

## The buckets

| Bucket       | What it is                                                                                         |
| ------------ | -------------------------------------------------------------------------------------------------- |
| **model**    | The model requests: from the request going out to the response's last chunk — split into the wait for the first byte and the phases that followed it. |
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

## The model's phases

The **model** bucket is not one number — it is a request's time, split. The
wait for the response's first byte is the queueing and the input
processing; what came after it is what the model did with it:

| Phase   | What it is                                                              |
| ------- | ----------------------------------------------------------------------- |
| **ttfb** | The wait for the first byte: the queue, and reading your context in.   |
| **gen**  | Everything after the first byte — the four phases below added up.      |
| **think** | The model was thinking (extended thinking).                             |
| **text**  | The model was writing the text you see.                                |
| **tool**  | The model was writing a tool call — its name and its arguments.        |
| **api**   | The API's own work between blocks: boundaries, retries, the tools the API runs itself. |

```
model     48.2s     4 requests · ttfb 3.1s · gen 45.1s · think 20.1s · text 22.4s · tool 2.6s
```

So a slow model is one of three things: a long wait for the first byte (a
big context), a lot of thinking, or a lot of output. The phases add up to
the model bucket exactly — a stretch a tool covered is the tool's, the same
way the buckets do.

Each request is broken down the same way in the pane's details:

```
#0  12.4s  ttfb 0.9s  gen 11.5s  think 6.2s  text 4.1s  tool 1.2s
    test-model  in 1.1k · out 800 · 1 tool call(s)
```

## Surfaces

### AbovePrompt band

A live one-line summary of the running turn (and of the last turn once it
ends), with a **View** button:

```
▶ Timing: turn 42.1s · model 30.4s · tools 9.2s
```

It ticks once a second while a turn runs, and yields the band to other mods
when there is nothing to show.

### Pane — `/timing`

One block per turn, newest first. The summary is always visible; **Details**
expands the turn into every model request and every tool call:

```
▼ #2  1m 12s  14:32:05  find the bug in the parser
     model     48.2s     4 requests · ttfb 3.1s · gen 45.1s · think 20.1s · text 22.4s · tool 2.6s
     tools     18.1s     5 calls · exec 12.0s · 6.1s overhead · Bash 12.0s · Edit 4.0s
     approval   5.0s     waiting for you
     hooks      2.3s     cc-code-format-mod 1.8s
     other      3.4s     engine overhead
     tokens     in 1.2k   out 3.4k · cached 120k
     requests
     #0  12.4s  ttfb 0.9s  gen 11.5s  think 6.2s  text 4.1s  tool 1.2s
         test-model  in 1.1k · out 800 · 1 tool call(s)
     #1   8.1s  ttfb 1.2s  gen 6.9s  text 6.9s
         test-model  in 12.4k · out 2100
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
  come from the response's own usage. The chunks are typed, so the time
  between two chunks is the phase the later one belongs to — the model's
  thinking, its text, the tool call it is writing, or the API's own work
  between the blocks.
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
- The phase split is an attribution: the time between two chunks belongs to
  the phase of the chunk that arrived. The API's own work between the
  model's blocks lands in `api`, and the tools the API runs itself are
  counted there too — the request's own line says how long they took.
- A turn measured before this mod grew the phase split — one already in the
  timeline when the mod was reloaded — has no phases to show. Its time after
  the first byte is reported as one `api` stretch.
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
