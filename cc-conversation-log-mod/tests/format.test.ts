// Pure tests for hooks/format.ts.
//
// No engine, no DOM, no Node. Run with `claude plugin test ./cc-conversation-log-mod`.

import { describe, expect, test } from 'claude-code/testing'

import {
  countMessages,
  earlierCount,
  ordinal,
  pageLatest,
  roleColor,
  roleIcon,
  toolIcon,
  toolLabel,
  toolResultSummary,
  truncateText,
} from '../hooks/format'

describe('truncateText', () => {
  test('returns the input unchanged when short', () => {
    expect(truncateText('hello', 100)).toBe('hello')
  })
  test('returns "" for empty / undefined input', () => {
    expect(truncateText('', 100)).toBe('')
    expect(truncateText(undefined, 100)).toBe('')
  })
  test('cuts at the last newline at or before max', () => {
    // 5 lines of 10 chars each + newline at the boundary.
    const text = 'abcdefghi\njklmnopqr\nstuvwxyz0\n123456789\nABCDEFGHI\nEXTRA'
    const out = truncateText(text, 35)
    // Truncation marker is dynamic — `…(+N chars)` — so check by regex.
    const marker = out.match(/\…\(\+(?<n>\d+) chars\)/)
    expect(marker).not.toBeNull()
    expect(Number(marker?.groups?.n)).toBeGreaterThan(0)
    expect(out).toContain('\n')
  })
  test('falls back to a hard slice when there are no newlines', () => {
    const text = 'a'.repeat(500)
    const out = truncateText(text, 100)
    expect(out.length).toBeLessThan(150)
    const marker = out.match(/\…\(\+(?<n>\d+) chars\)/)
    expect(Number(marker?.groups?.n)).toBe(400)
  })
})

describe('ordinal', () => {
  test('1st, 2nd, 3rd, 4th', () => {
    expect(ordinal(1)).toBe('1st')
    expect(ordinal(2)).toBe('2nd')
    expect(ordinal(3)).toBe('3rd')
    expect(ordinal(4)).toBe('4th')
  })
  test('teens are all -th', () => {
    expect(ordinal(11)).toBe('11th')
    expect(ordinal(12)).toBe('12th')
    expect(ordinal(13)).toBe('13th')
    expect(ordinal(21)).toBe('21st')
    expect(ordinal(22)).toBe('22nd')
  })
})

describe('roleIcon / roleColor', () => {
  test('user is 👤 + cyan, assistant is 🤖 + magenta', () => {
    expect(roleIcon('user')).toBe('👤')
    expect(roleIcon('assistant')).toBe('🤖')
    expect(roleColor('user')).toBe('cyan')
    expect(roleColor('assistant')).toBe('magenta')
  })
})

describe('toolIcon', () => {
  test('known tools map to their glyphs', () => {
    expect(toolIcon('Read')).toBe('📖')
    expect(toolIcon('Edit')).toBe('✏️')
    expect(toolIcon('Bash')).toBe('🖥 ')
    expect(toolIcon('Glob')).toBe('🔎')
    expect(toolIcon('Agent')).toBe('🤖')
  })
  test('unknown / MCP tools fall back to ⚙', () => {
    expect(toolIcon('mcp__notion__query')).toBe('⚙')
  })
})

describe('toolLabel', () => {
  test('Bash surfaces the command', () => {
    expect(toolLabel('Bash', { command: 'ls -la' })).toBe('Bash: ls -la')
  })
  test('Read surfaces the file_path', () => {
    expect(toolLabel('Read', { file_path: 'src/foo.ts' })).toBe('Read: src/foo.ts')
  })
  test('Edit / Write surface the file_path', () => {
    expect(toolLabel('Edit', { file_path: 'a.ts', old_string: 'x', new_string: 'y' })).toBe(
      'Edit: a.ts',
    )
    expect(toolLabel('Write', { file_path: 'a.ts', content: '...' })).toBe('Write: a.ts')
  })
  test('long inputs get an inline ellipsis', () => {
    const longCmd = 'echo ' + 'a'.repeat(500)
    const label = toolLabel('Bash', { command: longCmd })
    expect(label.startsWith('Bash: ')).toBe(true)
    expect(label.endsWith('…')).toBe(true)
    expect(label.length).toBeLessThan(longCmd.length)
  })
  test('falls back to bare tool name when input is empty', () => {
    expect(toolLabel('Bash', {})).toBe('Bash')
  })
})

describe('toolResultSummary', () => {
  test('in flight when no result yet', () => {
    expect(toolResultSummary(undefined, undefined, false)).toBe('⏳ in flight')
  })
  test('error', () => {
    expect(toolResultSummary('boom', true, true)).toBe('✗ error')
  })
  test('empty result', () => {
    expect(toolResultSummary('', false, true)).toBe('✓ empty')
  })
  test('short result inline', () => {
    expect(toolResultSummary('hello world', false, true)).toBe('✓ hello world')
  })
  test('long result reports counts', () => {
    // 600 chars total: 5 lines of 120 chars each (119 chars + '\n').
    const text = ('a'.repeat(119) + '\n').repeat(5)
    const out = toolResultSummary(text, false, true)
    expect(out.startsWith('✓ 600 chars · 6 lines')).toBe(true)
  })
})

describe('countMessages', () => {
  test('counts user / assistant / tools in one pass', () => {
    const messages = [
      { role: 'user' as const, toolUses: [] },
      { role: 'assistant' as const, toolUses: [{ a: 1 }, { b: 2 }] },
      { role: 'assistant' as const, toolUses: [] },
      { role: 'user' as const, toolUses: [] },
    ]
    expect(countMessages(messages)).toEqual({
      user: 2,
      assistant: 2,
      tools: 2,
      total: 4,
    })
  })

  test('tolerates missing toolUses', () => {
    expect(countMessages([{ role: 'user' as const }])).toEqual({
      user: 1,
      assistant: 0,
      tools: 0,
      total: 1,
    })
  })
})

describe('pageLatest', () => {
  test('returns all when window >= total', () => {
    const arr = [1, 2, 3]
    expect(pageLatest(arr, 10)).toEqual([1, 2, 3])
  })
  test('returns the newest N', () => {
    const arr = [1, 2, 3, 4, 5]
    expect(pageLatest(arr, 3)).toEqual([3, 4, 5])
  })
  test('returns a NEW array (not a reference)', () => {
    const arr = [1, 2, 3]
    const out = pageLatest(arr, 10)
    expect(out).not.toBe(arr)
  })
  test('window = 0 returns empty array', () => {
    expect(pageLatest([1, 2, 3], 0)).toEqual([])
  })
})

describe('earlierCount', () => {
  test('0 when window covers everything', () => {
    expect(earlierCount(10, 10)).toBe(0)
    expect(earlierCount(10, 100)).toBe(0)
  })
  test('PAGE_SIZE when room is plentiful, capped to remaining', () => {
    expect(earlierCount(100, 50)).toBe(50) // PAGE_SIZE
    expect(earlierCount(70, 50)).toBe(20)  // < PAGE_SIZE
    expect(earlierCount(51, 50)).toBe(1)
  })
})
