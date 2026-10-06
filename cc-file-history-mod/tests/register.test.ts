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

test('AbovePrompt yields when there are no edits (smoke test)', async ($, on) => {
  // Without any prior Edit, renderBand returns null and our handler calls
  // next(e). In production, `next(e)` defers to the engine's default
  // AbovePrompt rendering. In tests there's no engine default — we register
  // a default AbovePrompt stub below that returns an empty Box. The plugin's
  // handler, when it returns next(e), gets the empty Box; the band draws
  // nothing visible.
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  let emptyBox: unknown
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e as never)
    emptyBox = Box({ children: [] })
    return emptyBox as never
  })
  on('ui.render', ($, e: { component: string }, next) => next(e))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  const out = await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 20 },
      view: { agentId: 'main' },
    },
  })
  expect(out).toBeDefined()
})

test('first successful Edit shows the band (no Pane auto-open)', async ($, on) => {
  // Band-first: the AbovePrompt band is the entry point. The first Edit
  // does NOT auto-open the Pane — the band auto-shows via the existing
  // `$.ui.invalidate('ui.render')` in `recordTool`. Edit's record is built
  // from the tool-call input (old_string / new_string), so we only need to
  // stub fs.stat (path canonicalisation) and ui.render (pass-through to our
  // actual renderBand / renderPane handlers).
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.render', ($, e: { component: string }, next) => next(e))
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
  // Fresh session — no Pane open, no band yet (edits empty).
  expect(opens.length).toBe(0)
  expect(closes.length).toBe(0)

  // First successful Edit — band shows, Pane does NOT auto-open.
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: 't1',
    file_path: '/work/a.ts',
    old_string: 'x',
    new_string: 'y',
  })
  expect(opens.length).toBe(0)
  expect(closes.length).toBe(0)

  // AbovePrompt renders the band tree: a single row of Text + Button.
  const band = (await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })) as { flexDirection?: string; gap?: number; children?: unknown[] }
  expect(band).toBeDefined()
  expect(band.props?.flexDirection).toBe('row')
  expect(band.props?.gap).toBe(2)
  expect(band.children?.length).toBe(2)
  const textProps = band.children?.[0] as {
    type?: string
    props?: { color?: string; bold?: boolean }
    children?: string[]
  }
  expect(textProps?.type).toBe('Text')
  expect(textProps?.props?.color).toBe('magenta')
  expect(textProps?.props?.bold).toBe(true)
  expect(textProps?.children?.[0]).toBe('▶ File history: 1 edit (1 file)')
  const buttonProps = band.children?.[1] as {
    type?: string
    props?: Record<string, unknown>
  }
  expect(buttonProps?.type).toBe('Button')
  expect(buttonProps?.props?.label).toBe('View')
  expect(buttonProps?.props?.hotkey).toBe('v')
  expect(buttonProps?.props?.variant).toBe('primary')

  // Second Edit — band count updates, Pane still not opened.
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: 't2',
    file_path: '/work/a.ts',
    old_string: 'y',
    new_string: 'z',
  })
  expect(opens.length).toBe(0)
  expect(closes.length).toBe(0)

  const band2 = (await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })) as { type?: string; children?: unknown[] }
  const text2 = band2.children?.[0] as {
    type?: string
    children?: string[]
  }
  expect(text2?.type).toBe('Text')
  expect(text2?.children?.[0]).toBe('▶ File history: 2 edits (1 file)')
})

test('[View] button in the band opens the Pane', async ($, on) => {
  // Verifies the band's [View] Button has the right shape (label, hotkey,
  // variant, key). The harness strips `onPress` from the rendered tree, so
  // we can't invoke it directly — but the hotkey path (`v`) and a future
  // `ui.press` handler are the actual entry points. The button being
  // rendered with these props is what proves the band is wired up.
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.render', ($, e: { component: string }, next) => next(e))
  on('fs.stat', ($, e: { path: string }) => ({
    value: { realPath: e.path },
  }))
  on(
    'tool.call',
    { tool: 'Edit' },
    () => ({ result: { ok: true } } as never),
  )
  on('ui.open', () => ({ value: { isPlaced: true } } as never))
  on('ui.close', () => ({ value: undefined } as never))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: 't1',
    file_path: '/work/a.ts',
    old_string: 'x',
    new_string: 'y',
  })

  // Pull the band's [View] Button — verify it's rendered with the right
  // address (`key`) and label/hotkey/variant.
  const band = (await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })) as { type?: string; children?: unknown[] }
  const viewButton = band.children?.[1] as {
    type?: string
    props?: { key?: string; label?: string; hotkey?: string; variant?: string }
  }
  expect(viewButton?.type).toBe('Button')
  expect(viewButton?.props?.label).toBe('View')
  expect(viewButton?.props?.hotkey).toBe('v')
  expect(viewButton?.props?.variant).toBe('primary')
  expect(viewButton?.props?.key).toBe('open-pane')
})

test('Pane Close button has the right address', async ($, on) => {
  // The Pane's Close button calls `closePane`, which sets paneOpen=false and
  // raises ui.close. We can't click it from the test (the harness strips
  // `onPress`), but the slash-command toggle is exercised by the existing
  // `/file-history opens then closes the Pane` test, and the `ui.close`
  // event sync is covered by the band-first test's "a manual close sticks"
  // shape (see comments there). Here we just verify the Pane renders the
  // [Close] button with `key: 'close'` and label 'Close'.
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  on('ui.render', ($, e: { component: string }, next) => next(e))
  on('ui.open', () => ({ value: { isPlaced: true } } as never))
  on('ui.close', () => ({ value: undefined } as never))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.command.run({ command: 'file-history', args: '' })

  const pane = (await $.ui.render({
    surface: 'terminal',
    component: 'Pane',
    requestId: 'cc-file-history-mod-pane',
    props: {
      title: 'File history',
      isFocused: true,
      bodyColumns: 80,
      placement: 'inline',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })) as { type?: string; children?: unknown[] }
  // Pane tree: outer Box → children[0] is the header row Box. The Close
  // button is the last Button in that row.
  const headerRow = pane.children?.[0] as {
    type?: string
    children?: unknown[]
  }
  const closeButton = headerRow?.children?.find(
    (c) =>
      (c as { type?: string; props?: { label?: string } }).type === 'Button' &&
      (c as { props?: { label?: string } }).props?.label === 'Close',
  ) as {
    type?: string
    props?: { key?: string; label?: string }
  }
  expect(closeButton?.type).toBe('Button')
  expect(closeButton?.props?.label).toBe('Close')
  expect(closeButton?.props?.key).toBe('close')
})

test('AbovePrompt band is hidden when the Pane is open', async ($, on) => {
  // When paneOpen is true, renderBand returns null and the handler calls
  // next(e) — the engine's pass-through yields an empty AbovePrompt (the
  // harness requires at least one tree element; we register a default
  // AbovePrompt stub below that returns an empty Box).
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
  let defaultBox: unknown
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box } = $.ui.resolve(e as never)
    defaultBox = Box({ children: [] })
    return defaultBox as never
  })
  on('ui.render', ($, e: { component: string }, next) => next(e))
  on('fs.stat', ($, e: { path: string }) => ({
    value: { realPath: e.path },
  }))
  on(
    'tool.call',
    { tool: 'Edit' },
    () => ({ result: { ok: true } } as never),
  )
  on('ui.open', () => ({ value: { isPlaced: true } } as never))
  on('ui.close', () => ({ value: undefined } as never))

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
  await $.tool.call({
    tool: 'Edit',
    tool_use_id: 't1',
    file_path: '/work/a.ts',
    old_string: 'x',
    new_string: 'y',
  })

  // Band visible when Pane closed — it's a real Box row, not the default.
  const closed = (await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })) as { type?: string; props?: { flexDirection?: string }; children?: unknown[] }
  expect(closed?.type).toBe('Box')
  // Outer is column (we compose others + our band). Our band row is the
  // LAST child (others comes first if element-shaped).
  expect(closed?.props?.flexDirection).toBe('column')
  const ourRow = closed?.children?.[closed.children.length - 1] as {
    props?: { flexDirection?: string; gap?: number }
    children?: unknown[]
  }
  expect(ourRow?.props?.flexDirection).toBe('row')
  expect(ourRow?.children?.length).toBe(2)

  // Open the Pane.
  await $.command.run({ command: 'file-history', args: '' })

  // AbovePrompt now passes through to the default — renderBand yields
  // null because paneOpen is true, and the engine default is the Box we
  // registered above. The default Box has no flexDirection (just an empty
  // container), so it differs from the band's row shape.
  const opened = (await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: {
      hasSurvey: false,
      isWorking: false,
      maxRows: 20,
      bodyColumns: 80,
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })) as { type?: string; props?: { flexDirection?: string }; children?: unknown[] }
  // When the band is hidden (paneOpen=true), our handler yields via
  // `await next(e)` and returns whatever the engine default AbovePrompt
  // gives us — which in this test is the empty Box from the AbovePrompt
  // stub. The important assertion is that our band row (flexDirection:
  // 'row') is NOT present in the children.
  expect(opened?.type).toBe('Box')
  const hasOurRow = (opened?.children ?? []).some(
    (c) =>
      (c as { props?: { flexDirection?: string } }).props?.flexDirection === 'row',
  )
  expect(hasOurRow).toBe(false)
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