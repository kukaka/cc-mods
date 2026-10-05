import { expect, test } from 'claude-code/testing'

import {
  cap,
  canonicalPath,
  diffStats,
  formatTime,
  groupByFile,
  basename,
  type EditRecord,
} from '../hooks/history'

const rec = (
  overrides: Partial<EditRecord> & { id: number; filePath: string; ts: number },
): EditRecord => ({
  kind: 'edit',
  toolUseId: `t${overrides.id}`,
  beforeExists: true,
  before: 'x',
  applied: true,
  ...overrides,
})

test('cap keeps the last N records in original order', () => {
  expect(cap([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5])
  expect(cap([1, 2], 5)).toEqual([1, 2])
  expect(cap([], 5)).toEqual([])
})

test('canonicalPath normalises separators and collapses "./"', () => {
  expect(canonicalPath('a/b/c')).toBe('a/b/c')
  expect(canonicalPath('a\\b\\c')).toBe('a/b/c')
  expect(canonicalPath('a/./b/c')).toBe('a/b/c')
  expect(canonicalPath('a\\.\\b\\c')).toBe('a/b/c')
})

test('basename returns the last path segment regardless of separator', () => {
  expect(basename('/x/y/z.ts')).toBe('z.ts')
  expect(basename('a\\b\\c.md')).toBe('c.md')
  expect(basename('plain.ts')).toBe('plain.ts')
  expect(basename('/trailing/')).toBe('')
})

test('diffStats counts line deltas', () => {
  const two = 'a\nb'      // 2 lines: ['a', 'b']
  const three = 'a\nb\nc' // 3 lines: ['a', 'b', 'c']
  expect(diffStats(two, two)).toEqual({ added: 0, removed: 0 })
  expect(diffStats(two, three)).toEqual({ added: 1, removed: 0 })
  expect(diffStats(three, two)).toEqual({ added: 0, removed: 1 })
  expect(diffStats(undefined, three)).toEqual({ added: 3, removed: 0 })
  expect(diffStats(three, undefined)).toEqual({ added: 0, removed: 3 })
})

test('formatTime produces HH:MM:SS', () => {
  // Anchor at a known wall-clock value. We don't pin the date, only shape.
  const out = formatTime(Date.now())
  expect(out).toMatch(/^\d{2}:\d{2}:\d{2}$/)
})

test('groupByFile orders file groups by most-recent edit; records within desc', () => {
  const records: EditRecord[] = [
    rec({ id: 1, filePath: '/work/a.ts', ts: 100 }),
    rec({ id: 2, filePath: '/work/a.ts', ts: 200 }),
    rec({ id: 3, filePath: '/work/b.ts', ts: 150 }),
    rec({ id: 4, filePath: '/work/b.ts', ts: 300 }),
  ]
  const groups = groupByFile(records)
  expect(groups.map(g => g.filePath)).toEqual(['/work/b.ts', '/work/a.ts'])
  expect(groups[0]?.records.map(r => r.id)).toEqual([4, 3])
  expect(groups[1]?.records.map(r => r.id)).toEqual([2, 1])
})

test('groupByFile dedupes canonicalised paths', () => {
  const records: EditRecord[] = [
    rec({ id: 1, filePath: '/work/a.ts', ts: 100 }),
    rec({ id: 2, filePath: '/work/./a.ts', ts: 200 }),
    rec({ id: 3, filePath: '\\work\\a.ts', ts: 150 }),
  ]
  const groups = groupByFile(records)
  expect(groups.length).toBe(1)
  expect(groups[0]?.filePath).toBe('/work/a.ts')
  expect(groups[0]?.records.map(r => r.id)).toEqual([2, 3, 1])
})

test('groupByFile on empty input returns []', () => {
  expect(groupByFile([])).toEqual([])
})