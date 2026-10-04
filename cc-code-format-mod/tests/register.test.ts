import { expect, test } from 'claude-code/testing'

// The session.append hook is a thin glue layer; its core logic lives in
// hooks/format.ts and is exercised by format.test.ts. Here we test the parts
// the kit can actually drive: session.start (registers the command) and
// command.run (handles /format-code ...).

const setup = (on: (event: string, fn: unknown) => void) => {
  on('session.start', () => ({ cwd: '/work' }))
  on('command.register', () => ({ value: undefined }))
}

test('session.start registers the /format-code command', async ($, on) => {
  on('session.start', () => ({ cwd: '/work' }))
  let registered: { name: string; description: string } | undefined
  on('command.register', ($, e: { name: string; description: string }) => {
    registered = e
    return { value: undefined }
  })

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  expect(registered?.name).toBe('format-code')
  expect(registered?.description).toBe('Toggle / inspect the LLM-output code formatter')
})

test('/format-code toggles on/off', async ($, on) => {
  setup(on as never)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  expect((await $.command.run({ command: 'format-code', args: '' })).text).toBe('disabled.')
  expect((await $.command.run({ command: 'format-code', args: '' })).text).toBe('enabled.')
  expect((await $.command.run({ command: 'format-code', args: 'off' })).text).toBe('disabled.')
  expect((await $.command.run({ command: 'format-code', args: 'on' })).text).toBe('enabled.')
})

test('/format-code status reports both flags', async ($, on) => {
  setup(on as never)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const r = await $.command.run({ command: 'format-code', args: 'status' })
  expect(r.text).toContain('enabled')
  expect(r.text).toContain('verbose: off')
})

test('/format-code verbose subcommand toggles', async ($, on) => {
  setup(on as never)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  expect((await $.command.run({ command: 'format-code', args: 'verbose' })).text).toBe('verbose on.')
  expect((await $.command.run({ command: 'format-code', args: 'verbose off' })).text).toBe('verbose off.')
  expect((await $.command.run({ command: 'format-code', args: 'verbose on' })).text).toBe(
    'verbose on (toasts after each rewrite).',
  )
})

test('/format-code help prints the usage table', async ($, on) => {
  setup(on as never)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const r = await $.command.run({ command: 'format-code', args: 'help' })
  expect(r.text).toContain('/format-code')
  expect(r.text).toContain('/format-code verbose')
})

test('unknown subcommand returns a helpful error', async ($, on) => {
  setup(on as never)

  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })

  const r = await $.command.run({ command: 'format-code', args: 'bogus' })
  expect(r.text).toContain('unknown argument')
  expect(r.text).toContain('/format-code help')
})