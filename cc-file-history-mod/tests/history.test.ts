import { expect, test } from 'claude-code/testing'

import {
  cap,
  canonicalPath,
  diffStats,
  formatTime,
  groupByFile,
  basename,
  parentPath,
  relativePath,
  relativeTime,
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

test('parentPath returns everything before basename with trailing slash', () => {
  expect(parentPath('/x/y/z.ts')).toBe('/x/y/')
  expect(parentPath('a\\b\\c.md')).toBe('a/b/')
  expect(parentPath('plain.ts')).toBe('')
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

test('relativeTime formats seconds/minutes/hours/days, falls back to formatTime', () => {
  const now = 1_000_000_000_000
  // Seconds
  expect(relativeTime(now - 5_000, now)).toBe('5s ago')
  expect(relativeTime(now - 59_000, now)).toBe('59s ago')
  // Minutes
  expect(relativeTime(now - 60_000, now)).toBe('1 min ago')
  expect(relativeTime(now - 59 * 60_000, now)).toBe('59 min ago')
  // Hours
  expect(relativeTime(now - 60 * 60_000, now)).toBe('1 hr ago')
  expect(relativeTime(now - 23 * 60 * 60_000, now)).toBe('23 hr ago')
  // Days
  expect(relativeTime(now - 24 * 60 * 60_000, now)).toBe('1d ago')
  expect(relativeTime(now - 6 * 24 * 60 * 60_000, now)).toBe('6d ago')
  // Older than a week → absolute HH:MM:SS
  const old = relativeTime(now - 8 * 24 * 60 * 60_000, now)
  expect(old).toMatch(/^\d{2}:\d{2}:\d{2}$/)
  // Clock skew (future timestamp) → absolute HH:MM:SS
  const future = relativeTime(now + 60_000, now)
  expect(future).toMatch(/^\d{2}:\d{2}:\d{2}$/)
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

test('relativePath strips cwd prefix when p sits under cwd', () => {
  expect(relativePath('/work/proj/a/b.ts', '/work/proj')).toBe('a/b.ts')
  expect(relativePath('/work/proj/a/b.ts', '/work/proj/')).toBe('a/b.ts')
})

test('relativePath returns p unchanged when p is outside cwd', () => {
  expect(relativePath('/tmp/foo.ts', '/work/proj')).toBe('/tmp/foo.ts')
  expect(relativePath('/work/other/a.ts', '/work/proj')).toBe('/work/other/a.ts')
})

test('relativePath canonicalises cwd and p before the prefix check', () => {
  // cwd has a middle "./" segment that canonicalPath should collapse.
  expect(relativePath('/work/proj/a/b.ts', '/work/./proj')).toBe('a/b.ts')
  // Trailing-slash cwd like the parent's parentPath helper emits.
  expect(relativePath('/work/proj/a/b.ts', '/work/proj/')).toBe('a/b.ts')
})

test('relativePath falls back to absolute when cwd is relative but p is absolute', () => {
  // Ambiguous case — leading "./" never appears in the absolute p.
  expect(relativePath('/work/proj/a/b.ts', '.\\work\\proj')).toBe(
    '/work/proj/a/b.ts',
  )
})

test('relativePath returns p as-is when cwd is null/empty/undefined', () => {
  expect(relativePath('/work/proj/a.ts', null)).toBe('/work/proj/a.ts')
  expect(relativePath('/work/proj/a.ts', '')).toBe('/work/proj/a.ts')
  expect(relativePath('/work/proj/a.ts', undefined)).toBe('/work/proj/a.ts')
})

test('relativePath returns "." when p equals cwd exactly', () => {
  expect(relativePath('/work/proj', '/work/proj')).toBe('.')
})

test('groupByFile with cwd collapses to project-relative keys', () => {
  const records: EditRecord[] = [
    rec({ id: 1, filePath: '/work/proj/a.ts', ts: 100 }),
    rec({ id: 2, filePath: '/work/proj/a.ts', ts: 200 }),
    rec({ id: 3, filePath: '/work/proj/inner/b.ts', ts: 150 }),
    rec({ id: 4, filePath: '/work/proj/inner/b.ts', ts: 300 }),
    // Outside cwd — appears as its own group, key stays absolute.
    rec({ id: 5, filePath: '/tmp/x.ts', ts: 250 }),
  ]
  // Sorted by most-recent record: inner/b.ts (300) > /tmp/x.ts (250) > a.ts (200).
  const groups = groupByFile(records, '/work/proj')
  expect(groups.map(g => g.filePath)).toEqual([
    'inner/b.ts',
    '/tmp/x.ts',
    'a.ts',
  ])
  expect(groups[0]?.records.map(r => r.id)).toEqual([4, 3])
  expect(groups[1]?.records.map(r => r.id)).toEqual([5])
  expect(groups[2]?.records.map(r => r.id)).toEqual([2, 1])
})