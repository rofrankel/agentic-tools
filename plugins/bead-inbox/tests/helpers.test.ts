import { expect, test } from 'claude-code/testing'

import type { AttnItem } from '../types'
import {
  applyFilter,
  filterText,
  inProject,
  parseInboxArgs,
  parseSnapshot,
  recentDuplicate,
  shouldRetry,
  splitCommandLine,
  splitLinks,
  storeSignature,
} from '../hooks/lib'

const NOW = Date.parse('2026-11-01T12:00:00Z')
const at = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

test('the latest identical comment under 2 minutes old is a retry', async () => {
  expect(recentDuplicate([{ text: 'Human answer: A', created_at: at(30) }], 'Human answer: A', NOW)).toBe(at(30))
  expect(recentDuplicate([{ text: 'Human answer: A', created_at: at(180) }], 'Human answer: A', NOW)).toBeUndefined()
})

test('an identical comment that is not the latest is a new decision', async () => {
  const comments = [
    { text: 'Human answer: APPROVED', created_at: at(60) },
    { text: 'Agent: rewrote the draft', created_at: at(30) },
  ]

  expect(recentDuplicate(comments, 'Human answer: APPROVED', NOW)).toBeUndefined()
})

test('whitespace differences still match; a missing or bad timestamp is not a retry', async () => {
  expect(recentDuplicate([{ text: 'Human answer: A\n', created_at: at(10) }], '  Human answer: A', NOW)).toBe(at(10))
  expect(recentDuplicate([{ text: 'Human answer: A' }], 'Human answer: A', NOW)).toBeUndefined()
  expect(recentDuplicate([{ text: 'Human answer: A', created_at: 'yesterday' }], 'Human answer: A', NOW)).toBeUndefined()
})

test('a comment stamped in the future (clock skew) counts as just now', async () => {
  expect(recentDuplicate([{ text: 'x', created_at: at(-300) }], 'x', NOW)).toBe(at(-300))
})

test('a lock error is retried for any command; a timeout only when nothing is created', async () => {
  const locked = { exitCode: 1, stdout: '', stderr: 'Error: database is locked' }
  const timedOut = { exitCode: 124, stdout: '', stderr: 'bd timed out or could not start: timeout' }

  expect(shouldRetry(['gate', 'resolve', 'x'], locked)).toBe(true)
  expect(shouldRetry(['comments', 'add', 'x'], locked)).toBe(true)
  expect(shouldRetry(['list'], timedOut)).toBe(true)
  expect(shouldRetry(['comments', 'add', 'x'], timedOut)).toBe(false)
  expect(shouldRetry(['gate', 'create'], timedOut)).toBe(false)
  expect(shouldRetry(['q', 'Follow up'], timedOut)).toBe(false)
  expect(shouldRetry(['gate', 'resolve', 'x'], { exitCode: 1, stdout: '', stderr: 'no such gate' })).toBe(false)
  expect(shouldRetry(['gate', 'resolve', 'x'], { exitCode: 1, stdout: '', stderr: 'it blocks x' })).toBe(false)
  expect(shouldRetry(['list'], { exitCode: 127, stdout: '', stderr: 'bd not found on PATH' })).toBe(false)
})

test('/inbox arguments: a kind by name or tag, project: in either order, junk ignored', async () => {
  expect(parseInboxArgs('')).toEqual({})
  expect(parseInboxArgs(undefined)).toEqual({})
  expect(parseInboxArgs('decision')).toEqual({ kind: 'decision' })
  expect(parseInboxArgs('approve')).toEqual({ kind: 'approval' })
  expect(parseInboxArgs('project:Web decide')).toEqual({ kind: 'decision', project: 'web' })
  expect(parseInboxArgs('DECIDE  project:web  whatever')).toEqual({ kind: 'decision', project: 'web' })
  expect(parseInboxArgs('project:')).toEqual({})
})

const item = (id: string, kind: AttnItem['kind'], project: string): AttnItem => ({
  id,
  title: id,
  kind,
  details: '',
  createdAt: '2026-10-30T00:00:00Z',
  isGate: true,
  project,
})

test('filtering by kind, project (with subprojects) or both, in KINDS order', async () => {
  const list = [
    item('a', 'question', 'web'),
    item('b', 'approval', 'web:api'),
    item('c', 'decision', 'webapp'),
    item('d', 'decision', 'web'),
  ]

  expect(applyFilter(list, { kind: 'decision' }).map(one => one.id)).toEqual(['c', 'd'])
  expect(applyFilter(list, { project: 'web' }).map(one => one.id)).toEqual(['b', 'd', 'a'])
  expect(applyFilter(list, { project: 'web', kind: 'decision' }).map(one => one.id)).toEqual(['d'])
  expect(inProject('web:api', 'web')).toBe(true)
  expect(inProject('webapp', 'web')).toBe(false)
  expect(filterText({ project: 'web', kind: 'decision' }, 1, 4)).toBe('Filter: project web · kind decide (1 of 4)')
})

test('markdown links split out of text, everything else plain and in order', async () => {
  expect(splitLinks('no links here')).toEqual([{ text: 'no links here' }])
  expect(splitLinks('see [the PR](https://x.io/1) now')).toEqual([
    { text: 'see ' },
    { text: 'the PR', href: 'https://x.io/1' },
    { text: ' now' },
  ])
  expect(splitLinks('[a](https://a)[b](https://b)')).toEqual([
    { text: 'a', href: 'https://a' },
    { text: 'b', href: 'https://b' },
  ])
  expect(splitLinks('[](https://empty)')).toEqual([{ text: 'https://empty', href: 'https://empty' }])
  expect(splitLinks('[x](https://a b)')).toEqual([{ text: '[x](https://a b)' }])
  expect(splitLinks('[[x]](y) and [cut](https://tru…')).toEqual([{ text: '[[x]](y) and [cut](https://tru…' }])
  expect(splitLinks('[start](https://s) mid [end](https://e)')).toEqual([
    { text: 'start', href: 'https://s' },
    { text: ' mid ' },
    { text: 'end', href: 'https://e' },
  ])
})

test('a command line splits on spaces and groups quotes', async () => {
  expect(splitCommandLine('')).toEqual([])
  expect(splitCommandLine('  ec.py snapshot --json ')).toEqual(['ec.py', 'snapshot', '--json'])
  expect(splitCommandLine('"C:\\Program Files\\ec.exe" \'a b\' ""')).toEqual(['C:\\Program Files\\ec.exe', 'a b', ''])
})

test('snapshot output: data, bad output, or not there yet', async () => {
  expect(parseSnapshot('{"gates":[{"id":"g"}],"attn":[],"started":1800000000}')).toEqual({
    gates: '[{"id":"g"}]',
    attn: '[]',
    started: 1_800_000_000_000,
  })
  expect(parseSnapshot('{"gates":[],"attn":[]}')).toEqual({ gates: '[]', attn: '[]', started: 0 })
  expect(parseSnapshot('not json')).toEqual({ error: 'bad snapshot output' })
  expect(parseSnapshot('{"gates":[]}')).toEqual({ error: 'no bd snapshot yet' })
  expect(parseSnapshot('{"error":"warming up"}')).toEqual({ error: 'no bd snapshot yet: warming up' })
})

test('the store signature changes with the journal, the manifest or the databases', async () => {
  const base = { database: 'embeddeddolt/ait', journalSize: 100, manifest: 'm1' }
  const signature = storeSignature([base])

  expect(storeSignature([])).toBeUndefined()
  expect(storeSignature([{ ...base }])).toBe(signature)
  expect(storeSignature([{ ...base, journalSize: 101 }])).not.toBe(signature)
  expect(storeSignature([{ ...base, manifest: 'm2' }])).not.toBe(signature)
  expect(storeSignature([base, { ...base, database: 'embeddeddolt/other' }])).not.toBe(signature)
})
