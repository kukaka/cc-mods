import { expect, test } from 'claude-code/testing'
import {
  formatText,
  FENCE_RE,
  type FmtDeps,
} from '../hooks/format'

interface CallRecord {
  kind: 'process.run' | 'fs.write' | 'fs.read'
  argv?: readonly string[]
  init?: { stdin?: string; timeoutMs?: number; cwd?: string }
  path?: string
  text?: string
}

interface MockResult {
  exitCode: number
  stdout: string
  stderr: string
  isStdoutTruncated: boolean
  isStderrTruncated: boolean
}

interface MockEnv {
  deps: FmtDeps
  calls: CallRecord[]
  setProcessOutput: (output: Partial<MockResult>) => void
}

function makeMock(): MockEnv {
  const calls: CallRecord[] = []
  const processQueue: Array<Partial<MockResult>> = []
  const readQueue: Array<string> = []

  const deps: FmtDeps = {
    runProcess: async (argv, init) => {
      calls.push({ kind: 'process.run', argv, init })
      const next = processQueue.shift() ?? { exitCode: 1, stdout: '', stderr: 'no stub queued' }
      return {
        exitCode: next.exitCode ?? 0,
        stdout: next.stdout ?? '',
        stderr: next.stderr ?? '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      }
    },
    writeFile: async (path, text) => {
      calls.push({ kind: 'fs.write', path, text })
    },
    readFile: async (path) => {
      calls.push({ kind: 'fs.read', path })
      return readQueue.shift() ?? ''
    },
  }

  return {
    deps,
    calls,
    setProcessOutput: (output) => processQueue.push(output),
  }
}

// ---------------------------------------------------------------------------
// formatText
// ---------------------------------------------------------------------------

test('returns text unchanged when there are no code fences', async () => {
  const { deps, calls } = makeMock()
  const result = await formatText('Just plain text with no fences.', deps)
  expect(result.text).toBe('Just plain text with no fences.')
  expect(result.formatted).toBe(0)
  expect(result.failed).toBe(0)
  expect(calls).toHaveLength(0)
})

test('rewrites a python code block via black on stdin', async () => {
  const { deps, calls, setProcessOutput } = makeMock()
  setProcessOutput({
    exitCode: 0,
    stdout: 'def multiply(x, y):\n    return x * y\n',
  })
  const result = await formatText(
    'Some prose.\n\n```python\ndef multiply(x,y):\n  return  x  *  y\n```\n\nMore prose.',
    deps,
  )
  expect(result.formatted).toBe(1)
  expect(result.failed).toBe(0)
  expect(result.text).toContain('def multiply(x, y):')
  expect(result.text).toContain('return x * y')
  expect(result.text).not.toContain('return  x  *  y')
  expect(calls).toHaveLength(1)
  expect(calls[0].argv).toEqual(['python3', '-m', 'black', '-', '--quiet'])
  expect(calls[0].init?.stdin).toContain('def multiply(x,y):')
})

test('formats javascript through prettier with the babel parser', async () => {
  const { deps, calls, setProcessOutput } = makeMock()
  setProcessOutput({
    exitCode: 0,
    stdout: 'const greet = (name) => {\n  return `hi ${name}`;\n};\n',
  })
  const result = await formatText('```js\nconst greet=(name)=>{return `hi ${name}`}\n```', deps)
  expect(result.formatted).toBe(1)
  expect(calls[0].argv).toContain('prettier@3')
  expect(calls[0].argv).toContain('--parser')
  expect(calls[0].argv).toContain('babel')
  expect(result.text).toContain('const greet = (name) => {')
})

test('uses typescript parser for ts fences', async () => {
  const { deps, calls, setProcessOutput } = makeMock()
  setProcessOutput({ exitCode: 0, stdout: 'export const x = 1;\n' })
  await formatText('```ts\nexport const x=1\n```', deps)
  expect(calls[0].argv).toContain('typescript')
})

test('writes a temp file then runs rustfmt for rust blocks', async () => {
  const { deps, calls } = makeMock()
  // For file-based formatters: fs.write writes the body, runProcess runs the
  // formatter, fs.read reads the rewritten body.
  const depsWithRead: FmtDeps = {
    ...deps,
    readFile: async (path) => {
      calls.push({ kind: 'fs.read', path })
      return 'fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n'
    },
    runProcess: async (argv, init) => {
      calls.push({ kind: 'process.run', argv, init })
      return {
        exitCode: 0,
        stdout: '',
        stderr: '',
        isStdoutTruncated: false,
        isStderrTruncated: false,
      }
    },
  }
  const result = await formatText(
    '```rust\nfn add(a:i32,b:i32)->i32{\na+b\n}\n```',
    depsWithRead,
  )
  expect(result.formatted).toBe(1)
  const write = calls.find(c => c.kind === 'fs.write')
  expect(write).toBeDefined()
  expect(write!.path).toMatch(/\.rs$/)
  expect(write!.text).toContain('fn add')
  const proc = calls.find(c => c.kind === 'process.run')
  expect(proc!.argv?.[0]).toBe('rustfmt')
  expect(result.text).toContain('fn add(a: i32, b: i32) -> i32 {')
})

test('leaves diff blocks alone', async () => {
  const { deps, calls } = makeMock()
  const original = '```diff\n- old\n+ new\n```'
  const result = await formatText(original, deps)
  expect(result.formatted).toBe(0)
  expect(result.text).toBe(original)
  expect(calls).toHaveLength(0)
})

test('leaves blocks with no language alone', async () => {
  const { deps, calls } = makeMock()
  const original = '```\nplain code\n```'
  const result = await formatText(original, deps)
  expect(result.formatted).toBe(0)
  expect(result.text).toBe(original)
  expect(calls).toHaveLength(0)
})

test('passes through when the formatter exits non-zero', async () => {
  const { deps, setProcessOutput } = makeMock()
  setProcessOutput({ exitCode: 1, stdout: '', stderr: 'black: command not found' })
  const original = '```python\ndef f():\n  return 1\n```'
  const result = await formatText(original, deps)
  expect(result.formatted).toBe(0)
  expect(result.failed).toBe(0)
  expect(result.text).toBe(original)
})

test('swallows runProcess errors (no formatter available → silent skip)', async () => {
  const deps: FmtDeps = {
    runProcess: async () => {
      throw new Error('network down')
    },
    writeFile: async () => {},
    readFile: async () => '',
  }
  const result = await formatText('```python\nx=1\n```', deps)
  expect(result.formatted).toBe(0)
  expect(result.failed).toBe(0)
  expect(result.text).toBe('```python\nx=1\n```')
})

test('formats multiple blocks in one response', async () => {
  const { deps, calls, setProcessOutput } = makeMock()
  setProcessOutput({ exitCode: 0, stdout: 'a = 1\n' })
  setProcessOutput({ exitCode: 0, stdout: 'const x = 1;\n' })
  const result = await formatText(
    '```python\na=1\n```\n\ntext\n\n```js\nvar x=1\n```',
    deps,
  )
  expect(result.formatted).toBe(2)
  expect(calls.filter(c => c.kind === 'process.run')).toHaveLength(2)
  expect(result.text).toContain('a = 1\n')
  expect(result.text).toContain('const x = 1;\n')
})

test('handles attributes after the language tag', async () => {
  const { deps, calls, setProcessOutput } = makeMock()
  setProcessOutput({ exitCode: 0, stdout: 'a = 1\n' })
  await formatText('```python hl_lines="1"\na=1\n```', deps)
  // Python goes through black (TOOL_LANGS), not prettier; the language tag
  // doesn't appear in the argv, but the body still flows through black.
  expect(calls[0].argv).toContain('black')
  expect(calls[0].init?.stdin).toContain('a=1')
})

test('accepts CRLF after the language tag', async () => {
  const { deps, calls, setProcessOutput } = makeMock()
  setProcessOutput({ exitCode: 0, stdout: 'a = 1\n' })
  await formatText('```python\r\na=1\r\n```', deps)
  expect(calls).toHaveLength(1)
})

test('trims trailing whitespace and adds a single newline', async () => {
  const { deps, setProcessOutput } = makeMock()
  setProcessOutput({ exitCode: 0, stdout: 'a = 1\n\n\n   \n' })
  const result = await formatText('```python\na=1\n```', deps)
  expect(result.text).toMatch(/```python\na = 1\n```/)
})

// ---------------------------------------------------------------------------
// FENCE_RE
// ---------------------------------------------------------------------------

test('FENCE_RE matches a simple python fence', () => {
  FENCE_RE.lastIndex = 0
  const m = FENCE_RE.exec('```python\nx = 1\n```')
  expect(m).not.toBeNull()
  expect(m![1]).toBe('python')
  expect(m![2]).toBe('x = 1\n')
})

test('FENCE_RE captures empty language tag', () => {
  FENCE_RE.lastIndex = 0
  const m = FENCE_RE.exec('```\nplain\n```')
  expect(m).not.toBeNull()
  expect(m![1]).toBe('')
  expect(m![2]).toBe('plain\n')
})

test('FENCE_RE captures attributes after the language tag', () => {
  FENCE_RE.lastIndex = 0
  const m = FENCE_RE.exec('```python hl_lines="1 3"\nx = 1\n```')
  expect(m).not.toBeNull()
  expect(m![1]).toBe('python')
})