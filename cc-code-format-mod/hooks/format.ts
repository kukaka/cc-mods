// Pure formatting helpers. The session.append hook in register.tsx extracts
// the methods it needs from $ and passes them as plain function values so the
// engine's capability check (which forbids passing $ across an import) stays
// happy. unit tests pass mock functions in directly.

export interface FmtDeps {
  runProcess: (
    argv: readonly string[],
    init?: { stdin?: string; timeoutMs?: number; cwd?: string },
  ) => Promise<{
    exitCode: number
    stdout: string
    stderr: string
    isStdoutTruncated: boolean
    isStderrTruncated: boolean
  }>
  writeFile: (path: string, text: string) => Promise<void>
  readFile: (path: string) => Promise<string>
}

// ---------------------------------------------------------------------------
// Formatter tables
// ---------------------------------------------------------------------------

export const PRETTIER_PARSERS: Record<string, string> = {
  javascript: 'babel',
  js: 'babel',
  jsx: 'babel',
  mjs: 'babel',
  cjs: 'babel',
  flow: 'flow',
  typescript: 'typescript',
  ts: 'typescript',
  tsx: 'tsx',
  json: 'json',
  json5: 'json5',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  less: 'less',
  html: 'html',
  htm: 'html',
  vue: 'vue',
  svelte: 'svelte',
  astro: 'astro',
  angular: 'angular',
  yaml: 'yaml',
  yml: 'yaml',
  markdown: 'markdown',
  md: 'markdown',
  mdx: 'mdx',
  graphql: 'graphql',
  gql: 'graphql',
  toml: 'toml',
}

export const TOOL_LANGS: Record<string, { tool: string; argv: readonly string[] }> = {
  // `--code` is for inline mode and conflicts with stdin `-`. With `-`, black
  // reads from stdin and prints the formatted result to stdout.
  python: { tool: 'python3', argv: ['-m', 'black', '-', '--quiet'] },
  py: { tool: 'python3', argv: ['-m', 'black', '-', '--quiet'] },
  go: { tool: 'gofmt', argv: [] },
  golang: { tool: 'gofmt', argv: [] },
  bash: { tool: 'shfmt', argv: ['-i', '2', '-'] },
  sh: { tool: 'shfmt', argv: ['-i', '2', '-'] },
  shell: { tool: 'shfmt', argv: ['-i', '2', '-'] },
  zsh: { tool: 'shfmt', argv: ['-i', '2', '-'] },
}

export const FILE_LANGS: Record<string, { tool: string; ext: string }> = {
  rust: { tool: 'rustfmt', ext: 'rs' },
  rs: { tool: 'rustfmt', ext: 'rs' },
}

export const SKIP_LANGS = new Set<string>([
  '',
  'diff',
  'plaintext',
  'text',
  'console',
  'log',
  'shell-session',
  'shellsession',
  'ansi',
  'output',
  'txt',
])

// ---------------------------------------------------------------------------
// Fence regex: ```<lang> [attrs]\n<body>```
//   group 1 = lang tag, group 2 = body
// ---------------------------------------------------------------------------

export const FENCE_RE = /```([A-Za-z0-9_+\-]*)[^\n]*\n([\s\S]*?)```/g

// ---------------------------------------------------------------------------
// Timeouts
// ---------------------------------------------------------------------------

export const PRETTIER_TIMEOUT_MS = 15_000
export const NATIVE_TIMEOUT_MS = 10_000
export const TEMP_DIR = `/tmp/cc-code-format-mod`

// ---------------------------------------------------------------------------
// Pure helpers (testable without firing session.append)
// ---------------------------------------------------------------------------

export interface TextResult {
  text: string
  formatted: number
  failed: number
}

interface Fence {
  lang: string
  body: string
  start: number
  end: number
  raw: string
}

export async function formatText(text: string, deps: FmtDeps): Promise<TextResult> {
  const fences: Fence[] = []
  FENCE_RE.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = FENCE_RE.exec(text)) !== null) {
    fences.push({
      lang: (m[1] ?? '').toLowerCase(),
      body: m[2],
      start: m.index,
      end: m.index + m[0].length,
      raw: m[0],
    })
  }
  if (fences.length === 0) return { text, formatted: 0, failed: 0 }

  let out = ''
  let cursor = 0
  let formatted = 0
  let failed = 0
  for (const f of fences) {
    out += text.slice(cursor, f.start)
    try {
      const replacement = await formatBlock(f.lang, f.body, deps)
      if (replacement !== null) {
        out += '```' + f.lang + '\n' + replacement + '```'
        formatted += 1
      } else {
        out += f.raw
      }
    } catch {
      out += f.raw
      failed += 1
    }
    cursor = f.end
  }
  out += text.slice(cursor)
  return { text: out, formatted, failed }
}

export async function formatBlock(
  lang: string,
  code: string,
  deps: FmtDeps,
): Promise<string | null> {
  if (SKIP_LANGS.has(lang)) return null
  if (!code.trim()) return null

  const parser = PRETTIER_PARSERS[lang]
  if (parser !== undefined) {
    return runStdin(
      'npx',
      [
        '--yes',
        'prettier@3',
        '--stdin-filepath',
        `file.${lang || 'txt'}`,
        '--parser',
        parser,
      ],
      code,
      deps,
      PRETTIER_TIMEOUT_MS,
    )
  }

  const tool = TOOL_LANGS[lang]
  if (tool !== undefined) {
    return runStdin(tool.tool, tool.argv, code, deps, NATIVE_TIMEOUT_MS)
  }

  const fileTool = FILE_LANGS[lang]
  if (fileTool !== undefined) {
    return formatWithFile(fileTool.tool, fileTool.ext, code, deps)
  }

  return null
}

export async function runStdin(
  cmd: string,
  argv: readonly string[],
  stdin: string,
  deps: FmtDeps,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const result = await deps.runProcess([cmd, ...argv], { stdin, timeoutMs })
    if (result.exitCode === 0 && result.stdout.length > 0) {
      return result.stdout.replace(/\s+$/, '') + '\n'
    }
  } catch {
    /* formatter unavailable, network down, timeout, etc. */
  }
  return null
}

export async function formatWithFile(
  tool: string,
  ext: string,
  code: string,
  deps: FmtDeps,
): Promise<string | null> {
  const fileName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
  const path = `${TEMP_DIR}/${fileName}`
  try {
    await deps.writeFile(path, code)
    const result = await deps.runProcess([tool, path], { timeoutMs: NATIVE_TIMEOUT_MS })
    if (result.exitCode === 0) {
      const out = await deps.readFile(path)
      return out.replace(/\s+$/, '') + '\n'
    }
  } catch {
    /* ignore */
  }
  return null
}