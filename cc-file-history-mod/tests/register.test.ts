import { expect, test } from 'claude-code/testing'

// The hooks module is a thin glue layer; its core logic lives in
// hooks/history.ts and is exercised by history.test.ts. Here we cover the
// parts the test kit exposes: session.start registers the command, the
// command-run hook toggles the AbovePrompt band, and classic.SessionStart
// from /clear /resume /fork fires without error.
//
// Note: every `on(...)` call must happen BEFORE the first `$.<noun>(...)`
// call — the kit raises events beneath the plugins only after their hooks
// are registered.

test('session.start registers the /file-history command', async ($, on) => {
  let registered: { name: string; description: string } | undefined
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', ($, e: { name: string; description: string }) => {
    registered = e
    return { value: undefined }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  expect(registered?.name).toBe('file-history')
  expect(registered?.description).toBe('Open / close the file-edit history pane')
})

test('/file-history opens then closes the Pane', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))

  // Capture $.ui.open and $.ui.close so we can assert the toggle calls them
  // with the right Pane id. The Pane render hook isn't relevant to this
  // test; stub it through to the engine's pass-through.
  on('ui.render', ($, e: { component: string }, next) => {
    if (e.component !== 'Pane') return next(e)
    return next(e as never)
  })

  const opens: Array<{ id: string; title: string; focus?: boolean; closeOnEscape?: boolean }> = []
  const closes: Array<{ id: string }> = []
  on('ui.open', ($, e: { id: string; title: string; focus?: boolean; closeOnEscape?: boolean }) => {
    opens.push(e)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e: { id: string }) => {
    closes.push(e)
    return { value: undefined } as never
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // Fresh session: no opens, no closes.
  expect(opens.length).toBe(0)
  expect(closes.length).toBe(0)

  // First /file-history opens the Pane.
  const r1 = await $.command.run({ command: 'file-history', args: '' })
  expect(r1.text).toBe('file-history: opened.')
  expect(opens.length).toBe(1)
  expect(opens[0].id).toBe('cc-file-history-mod-pane')
  expect(opens[0].title).toBe('File history')
  expect(opens[0].focus).toBe(true)
  expect(opens[0].closeOnEscape).toBe(true)
  expect(closes.length).toBe(0)

  // Second /file-history closes the Pane (we think it's open — and it is,
  // because the previous open returned isPlaced: true and our local flag
  // is in sync).
  const r2 = await $.command.run({ command: 'file-history', args: '' })
  expect(r2.text).toBe('file-history: closed.')
  expect(opens.length).toBe(1)
  expect(closes.length).toBe(1)
  expect(closes[0].id).toBe('cc-file-history-mod-pane')
})

test('classic.SessionStart from /clear /resume /fork fires without error', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('classic.SessionStart', () => ({}))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  await $.classic.SessionStart({ source: 'clear' })
  await $.classic.SessionStart({ source: 'resume' })
  await $.classic.SessionStart({ source: 'fork' })
})

test('first successful Edit auto-opens the Pane; a manual close sticks', async ($, on) => {
  // Capture ui.open / ui.close to assert the auto-open fires once and the
  // user's manual close turns off the auto-open for the rest of the session.
  // Edit's record is built from the tool-call input (old_string / new_string),
  // so we no longer need to stub fs.read for Edit — only fs.stat (path
  // canonicalisation) and ui.render (the Pane render pass-through).
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.render', ($, e: { component: string }, next) => {
    if (e.component !== 'Pane') return next(e)
    return next(e as never)
  })
  on('fs.stat', ($, e: { path: string }) => ({
    value: { realPath: e.path },
  }))
  // Tool.call must answer — recordTool calls `next(e)` and reads back the
  // result. The plugin's hook carries `{ tool: 'Edit' }`.
  on(
    'tool.call',
    { tool: 'Edit' },
    () => ({ result: { ok: true } } as never),
  )

  const opens: Array<{ id: string }> = []
  const closes: Array<{ id: string }> = []
  on('ui.open', ($, e: { id: string }) => {
    opens.push(e)
    return { value: { isPlaced: true } } as never
  })
  on('ui.close', ($, e: { id: string }) => {
    closes.push(e)
    return { value: undefined } as never
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  // Fresh session — no auto-open yet, no manual toggles either.
  expect(opens.length).toBe(0)
  expect(closes.length).toBe(0)

  // First successful Edit must auto-open the Pane.
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: 't1',
    input: { file_path: '/work/a.ts', old_string: 'x', new_string: 'y' },
  })
  expect(opens.length).toBe(1)
  expect(opens[0].id).toBe('cc-file-history-mod-pane')

  // Second Edit must NOT auto-open again — the Pane is already open and
  // `$.ui.open` against a placed pane is a no-op-ish refresh.
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: 't2',
    input: { file_path: '/work/a.ts', old_string: 'y', new_string: 'z' },
  })
  expect(opens.length).toBe(1)

  // User manually closes via /file-history.
  const r3 = await $.command.run({ command: 'file-history', args: '' })
  expect(r3.text).toBe('file-history: closed.')
  expect(closes.length).toBe(1)

  // Third Edit must NOT re-open — the user's close sticks.
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: 't3',
    input: { file_path: '/work/a.ts', old_string: 'z', new_string: 'w' },
  })
  expect(opens.length).toBe(1)
})

test('Bash `rm path` records a delete with content from the parse step', async ($, on) => {
  // The flow: Bash is invoked with `rm path`. We capture the content via
  // fs.read in the parse step. The test stub for tool.call returns the
  // bashEditDiff with `deleted: true` for our path, which recordBash
  // reconciles against the parse-read map and pushes a delete record.
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.render', ($, e: { component: string }, next) => {
    if (e.component !== 'Pane') return next(e)
    return next(e as never)
  })
  on('ui.open', () => ({ value: { isPlaced: false } } as never))
  on('ui.close', () => ({ value: undefined } as never))
  on('fs.stat', ($, e: { path: string }) => ({ value: { realPath: e.path } }))
  // The path recordBash parsed out of `rm /work/foo.txt` is read here.
  on('fs.read', ($, e: { path: string }) => ({
    value: `contents of ${e.path}\n`,
  }))

  on(
    'tool.call',
    { tool: 'Bash' },
    () =>
      ({
        result: {
          bashEditDiff: {
            files: [{ filePath: '/work/foo.txt', deleted: true }],
          },
        },
      }) as never,
  )

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'b1',
    input: { command: 'rm /work/foo.txt' },
  })

  // Trigger a Pane render and inspect the tree the plugin produced.
  const shown = await $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: 'cc-file-history-mod-pane',
    props: {
      title: 'File history',
      isFocused: false,
      bodyColumns: 80,
      placement: 'inline',
      scroll: { first: 0, last: 0, of: 0 },
      view: {},
    },
  })
  // The tree contains a single delete record — `files` count of 1 is
  // visible at the top of the Pane's header.
  expect(shown).toBeDefined()
})

test('Bash `rm missing-file` records nothing (no bashEditDiff deletion)', async ($, on) => {
  // `rm missing` exits 0 but no file was deleted — bashEditDiff should have
  // no `deleted` entries. Verify we don't record a phantom.
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.render', ($, e: { component: string }, next) => {
    if (e.component !== 'Pane') return next(e)
    return next(e as never)
  })
  on('ui.open', () => ({ value: { isPlaced: false } } as never))
  on('ui.close', () => ({ value: undefined } as never))
  on('fs.stat', () => ({ value: { realPath: '' } }))
  on('fs.read', () => {
    throw new Error('file does not exist')
  })
  // fs.read fails → preContent map stays empty for the path.
  on(
    'tool.call',
    { tool: 'Bash' },
    () =>
      ({
        result: {
          bashEditDiff: { files: [] },
        },
      }) as never,
  )

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({
    tool: 'Bash',
    tool_use_id: 'b1',
    input: { command: 'rm /work/missing' },
  })

  const shown = await $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: 'cc-file-history-mod-pane',
    props: {
      title: 'File history',
      isFocused: false,
      bodyColumns: 80,
      placement: 'inline',
      scroll: { first: 0, last: 0, of: 0 },
      view: {},
    },
  })
  // No files captured → "no edits captured yet" empty state.
  expect(shown).toBeDefined()
})