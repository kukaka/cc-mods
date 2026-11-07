import { expect, test } from 'claude-code/testing'

// The AbovePrompt handler is the part of this mod the test kit can
// exercise end to end: it composes our band with the tree the other mods
// draw (what `await next(e)` resolves to).
//
// The bug these tests pin: the handler used to return our band alone,
// which cut the hook chain at this mod — every mod loaded after
// cc-context-mod (cc-conversation-log-mod, cc-file-history-mod) never ran
// at all, so its band never appeared. Our band now travels with the
// others', whatever order the mods are loaded in.
//
// Note: every `on(...)` call must happen BEFORE the first `$.<noun>(...)`
// call — the kit raises events beneath the plugins only after their hooks
// are registered.

/** The props of an AbovePrompt render, as the engine hands them. */
const ABOVE_PROMPT_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 20,
  bodyColumns: 80,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}

type Tree = {
  props?: {
    flexDirection?: string
    flexWrap?: string
    children?: unknown[]
  }
  children?: unknown[]
}

/** The stubs session.start needs; the mod reads usage and the env. */
function stubSession(on: (event: string, ...rest: never[]) => void): void {
  on('session.start', () => ({ cwd: '/work' }))
}

test('AbovePrompt carries the other mods band with ours', async ($, on) => {
  stubSession(on as never)
  // Another mod's AbovePrompt handler (the shape cc-timing-mod and
  // cc-file-history-mod draw): a plain row band.
  on('ui.render', { component: 'AbovePrompt' }, ($, e: { component: string }) => {
    const { Box, Text } = $.ui.resolve(e as never)
    return Box({
      flexDirection: 'row',
      children: [Text({ children: 'other-band' })],
    }) as never
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const tree = (await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: ABOVE_PROMPT_PROPS,
  })) as Tree

  // A column of two rows: our band and the other mod's.
  expect(tree?.props?.flexDirection).toBe('column')
  expect(tree?.children?.length).toBe(2)
  const ours = tree?.children?.[0] as Tree
  const theirs = tree?.children?.[1] as Tree
  // Ours: the row-with-wrap band (a section that doesn't fit wraps).
  expect(ours?.props?.flexDirection).toBe('row')
  expect(ours?.props?.flexWrap).toBe('wrap')
  // Theirs: their band, carried along.
  expect(theirs?.props?.flexDirection).toBe('row')
})

test('AbovePrompt draws our band alone when no other mod draws one', async ($, on) => {
  stubSession(on as never)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const tree = (await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: ABOVE_PROMPT_PROPS,
  })) as Tree

  // Nothing to compose with: our band as it always was.
  expect(tree?.props?.flexDirection).toBe('row')
  expect(tree?.props?.flexWrap).toBe('wrap')
})

test('AbovePrompt isolates the other band in an inner column on Windows Terminal', async ($, on) => {
  stubSession(on as never)
  // Stub env.get to report Windows Terminal.
  on('env.get', { name: 'WT_SESSION' }, () => ({
    value: '00000000-0000-0000-0000-000000000000',
  }))
  on('ui.render', { component: 'AbovePrompt' }, ($, e: { component: string }) => {
    const { Box, Text } = $.ui.resolve(e as never)
    return Box({
      flexDirection: 'row',
      children: [Text({ children: 'other-band' })],
    }) as never
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const tree = (await $.ui.render({
    surface: 'terminal',
    component: 'AbovePrompt',
    props: ABOVE_PROMPT_PROPS,
  })) as Tree

  expect(tree?.props?.flexDirection).toBe('column')
  expect(tree?.children?.length).toBe(2)
  // First child: our band, direct (the shape that always rendered).
  const ours = tree?.children?.[0] as Tree
  expect(ours?.props?.flexDirection).toBe('row')
  expect(ours?.props?.flexWrap).toBe('wrap')
  // Second child: the other band, wrapped in an inner column Box — a
  // row-with-wrap tree as a direct child of a column misbehaves on WT.
  const wrapper = tree?.children?.[1] as Tree
  expect(wrapper?.props?.flexDirection).toBe('column')
  expect(wrapper?.children?.length).toBe(1)
  const theirs = wrapper?.children?.[0] as Tree
  expect(theirs?.props?.flexDirection).toBe('row')
})
