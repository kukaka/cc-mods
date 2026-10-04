// cc-code-format-mod
//
// Rewrites every fenced code block in an LLM response so it conforms to the
// language's standard style. Hooks `session.append { door: 'response' }`,
// walks the text blocks, finds ```lang\n<body>\n``` fences, dispatches each
// body to a language-appropriate formatter, and rewrites the row before the
// transcript stores it.
//
// The formatting logic lives in `./format.ts` so unit tests can exercise it
// directly without firing session.append through the test kit.

import { atom, update } from 'claude-code'
import type { Register } from 'claude-code'
import type { Stats } from '../types'
import { formatText, type FmtDeps } from './format'

// ---------------------------------------------------------------------------
// Persistent state (survives hot reload; keyed by plugin + key)
// ---------------------------------------------------------------------------

const statsAtom = atom(
  { plugin: 'cc-code-format-mod', key: 'stats' } as const,
  { formatted: 0, skipped: 0, failed: 0 } as Stats,
)

// Mirrors of `userConfig.enabled` (re-read on each (re)load) and a session
// toggle for verbose toasts. Module-scoped: a reload re-reads userConfig, and
// verbose is purely a /format-code runtime switch.
let configuredEnabled = true
let configuredVerbose = false

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

export const register: Register = (on, options) => {
  configuredEnabled = options.enabled !== false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'format-code',
      description: 'Toggle / inspect the LLM-output code formatter',
    })
    return next(e)
  })

  on('command.run', { command: 'format-code' }, async ($, e) => {
    const raw = (e.args ?? '').trim()
    const tokens = raw.toLowerCase().split(/\s+/).filter(Boolean)
    const verb = tokens[0] ?? ''
    const sub = tokens[1] ?? ''

    if (verb === 'help') {
      return {
        text: [
          '/format-code                  toggle on/off',
          '/format-code on               enable',
          '/format-code off              disable',
          '/format-code status           show on/off and verbose state',
          '/format-code verbose          toggle verbose toasts',
          '/format-code verbose on|off   set verbose mode',
        ].join('\n'),
      }
    }

    if (verb === 'verbose') {
      if (sub === 'on') {
        configuredVerbose = true
        return { text: 'verbose on (toasts after each rewrite).' }
      }
      if (sub === 'off') {
        configuredVerbose = false
        return { text: 'verbose off.' }
      }
      configuredVerbose = !configuredVerbose
      return {
        text: `verbose ${configuredVerbose ? 'on' : 'off'}.`,
      }
    }

    if (verb === 'on') {
      configuredEnabled = true
      return { text: 'enabled.' }
    }

    if (verb === 'off') {
      configuredEnabled = false
      return { text: 'disabled.' }
    }

    if (verb === 'status') {
      return {
        text:
          `${configuredEnabled ? 'enabled' : 'disabled'}. ` +
          `verbose: ${configuredVerbose ? 'on' : 'off'}.`,
      }
    }

    if (verb === '' || verb === 'toggle') {
      configuredEnabled = !configuredEnabled
      return {
        text: `${configuredEnabled ? 'enabled' : 'disabled'}.`,
      }
    }

    return {
      text: `unknown argument "${e.args}". Try /format-code help.`,
    }
  })

  on('session.append', { door: 'response' }, async ($, e, next) => {
    if (!configuredEnabled) return next(e)

    const content = e.message.content as Array<{
      type: string
      text?: unknown
      [field: string]: unknown
    }>

    let totalFormatted = 0
    let totalFailed = 0
    let anyChanged = false

    // $ cannot cross an import boundary (the engine's capability check), so
    // detach the methods we use and pass them as plain function values.
    const deps: FmtDeps = {
      runProcess: (argv, init) => $.process.run(argv, init),
      writeFile: (path, text) => $.fs.write(path, text),
      readFile: (path) => $.fs.read(path),
    }

    // Sequential so per-block file-based formatters don't race on /tmp.
    const newContent: typeof content = []
    for (const block of content) {
      if (block.type !== 'text' || typeof block.text !== 'string') {
        newContent.push(block)
        continue
      }
      const result = await formatText(block.text, deps)
      totalFormatted += result.formatted
      totalFailed += result.failed
      if (result.text === block.text) {
        newContent.push(block)
      } else {
        newContent.push({ ...block, text: result.text })
        anyChanged = true
      }
    }

    if (totalFormatted > 0 || totalFailed > 0) {
      await update($, statsAtom, prev => ({
        formatted: prev.formatted + totalFormatted,
        skipped: prev.skipped,
        failed: prev.failed + totalFailed,
      }))

      if (configuredVerbose) {
        if (totalFormatted > 0) {
          $.ui.toast(
            `formatted ${totalFormatted} code block${totalFormatted === 1 ? '' : 's'}`,
          )
        }
        if (totalFailed > 0) {
          $.ui.toast(
            `skipped ${totalFailed} block${totalFailed === 1 ? '' : 's'} (formatter error)`,
            { timeoutMs: 6000 },
          )
        }
      }
    }

    if (!anyChanged) return next(e)
    return next({ ...e, message: { ...e.message, content: newContent } })
  })
}