import { expect, mock, test } from 'claude-code/testing'

type Hook = (event: string, hook: unknown) => void
type Call = { argv: string[]; stdin?: string; env?: Record<string, string> }

const gate = (id: string, kind = 'decision') => ({
  id,
  title: `Question ${id}?`,
  status: 'open',
  issue_type: 'gate',
  await_type: 'human',
  created_at: '2026-10-30T00:00:00Z',
  labels: [`attn:${kind}`],
})

const answer = (stdout = '', exitCode = 0, stderr = '') => ({
  value: { exitCode, stdout, stderr, isStdoutTruncated: false, isStderrTruncated: false },
})

// Every process the plugin starts; `reply` may answer one itself.
const fakeRun = (on: unknown, rows: object[], reply: (call: Call) => unknown = () => undefined) => {
  const calls: Call[] = []
  ;(on as Hook)('process.run', async (_$: unknown, e: { argv: string[]; init?: { stdin?: string; env?: Record<string, string> } }) => {
    const call = { argv: [...e.argv], stdin: e.init?.stdin, env: e.init?.env }
    calls.push(call)
    const own = await reply(call)
    if (own !== undefined) {
      return own
    }
    if (e.argv[1] === 'list') {
      return answer(JSON.stringify(rows))
    }
    return answer()
  })

  return calls
}

const lists = (calls: Call[]) => calls.filter(call => call.argv[1] === 'list').length

// The host's side of session.start and turn.complete.
const host = (on: unknown) => {
  ;(on as Hook)('session.start', async (_$: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  ;(on as Hook)('turn.complete', async () => ({ text: '' }))
  for (const call of ['tool.register', 'command.register']) {
    ;(on as Hook)(call, async () => ({ value: undefined }))
  }
  ;(on as Hook)('ui.open', async () => ({ value: { isPlaced: true } }))
}

type Engine = {
  command: { run: (input: object) => Promise<{ text?: string }> }
  session: { start: (input: object) => Promise<unknown> }
  turn: { complete: (input: object) => Promise<unknown> }
}

const start = ($: unknown, isInteractive: boolean) =>
  ($ as Engine).session.start({ cwd: '/work/proj', surface: isInteractive ? 'terminal' : null, isInteractive })

const run = async ($: unknown, command: string, args?: string) =>
  ((await ($ as Engine).command.run(args === undefined ? { command } : { command, args })).text ?? '')

const { setTimeout: wait } = globalThis as unknown as { setTimeout: (fn: unknown, ms: number) => void }
const settled = () => new Promise(done => wait(done, 20))

// ---- §1, §2: the extraction backup ----

const subagentReport = ($: unknown) =>
  ($ as Engine).turn.complete({ agentId: 'a1', reason: 'answer', answer: 'Done. Should I use A or B?', text: '' })

const fakeModel = (on: unknown) => {
  const models: string[] = []
  ;(on as Hook)('model.complete', async (_$: unknown, e: { model: string }) => {
    models.push(e.model)
    return { value: { isAnswered: true, text: '[]', usage: { inputTokens: 0, outputTokens: 0 } } }
  })

  return models
}

test('the extractor asks for Sonnet by default', async ($, on) => {
  host(on)
  fakeRun(on, [])
  const models = fakeModel(on)
  await subagentReport($)
  await settled()

  expect(models).toEqual(['sonnet'])
})

test('the extractor model is a setting', { options: { extractorModel: 'haiku' } }, async ($, on) => {
  host(on)
  fakeRun(on, [])
  const models = fakeModel(on)
  await subagentReport($)
  await settled()

  expect(models).toEqual(['haiku'])
})

test('with auto-extraction off a report full of questions costs nothing', { options: { autoExtract: false } }, async ($, on) => {
  host(on)
  const calls = fakeRun(on, [])
  const models = fakeModel(on)
  await subagentReport($)
  await settled()

  expect(models).toEqual([])
  expect(calls).toEqual([])
})

// ---- §7: who polls ----

test('a non-interactive session never polls, but /inbox still reads bd', async ($, on) => {
  host(on)
  const clock = mock.clock(on as never, { now: 1_000_000 })
  const calls = fakeRun(on, [gate('g-1')])
  await start($, false)
  await clock.advance(300_000)

  expect(calls).toEqual([])
  expect(await run($, 'inbox')).toContain('1 item needs you')
  expect(lists(calls)).toBe(2)
})

test('an interactive session polls on the timer', { options: { storeSignature: false } }, async ($, on) => {
  host(on)
  const clock = mock.clock(on as never, { now: 1_000_000 })
  const calls = fakeRun(on, [gate('g-1')])
  await start($, true)
  await clock.settle()
  expect(lists(calls)).toBe(2)

  await clock.advance(60_000)
  expect(lists(calls)).toBe(4)
})

test('a snapshot command replaces the bd list calls', { options: { snapshotCommand: 'snap --json' } }, async ($, on) => {
  let stdout = JSON.stringify({ gates: [gate('g-1')], attn: [gate('t-1', 'question')], started: 1 })
  const calls = fakeRun(on, [], call => (call.argv[0] === 'snap' ? answer(stdout) : undefined))

  expect(await run($, 'inbox')).toContain('2 items need you')
  expect(calls.map(call => call.argv.join(' '))).toEqual(['snap --json'])

  stdout = 'not json at all'
  expect(await run($, 'inbox')).toContain('bad snapshot output')
  stdout = JSON.stringify({ gates: [], error: 'reader starting' })
  expect(await run($, 'inbox')).toContain('no bd snapshot yet: reader starting')
})

// ---- §8: forced refreshes and the on-answered command ----

test('forced refreshes during a slow one cause exactly one more', async ($, on) => {
  host(on)
  mock.clock(on as never, { now: 1_000_000 })
  let hold: Promise<void> | undefined
  let release: () => void = () => undefined
  const calls = fakeRun(on, [gate('g-1'), gate('g-2')], async call => {
    if (call.argv[1] === 'list' && hold) {
      const held = hold
      hold = undefined
      await held
    }
    return undefined
  })
  await start($, true)
  await settled()
  expect(lists(calls)).toBe(2)

  hold = new Promise<void>(done => {
    release = done
  })
  const slow = run($, 'inbox-list')
  await settled()
  await run($, 'answer', 'g-1 A')
  await run($, 'answer', 'g-2 B')
  release()
  await slow
  await settled()

  expect(lists(calls)).toBe(6)
})

test('the on-answered command runs once per saved answer, never for a failed one', { options: { onAnsweredCommand: 'dispatch --now' } }, async ($, on) => {
  const calls = fakeRun(on, [gate('g-1'), gate('g-2')], call =>
    call.argv[1] === 'gate' && call.argv[3] === 'g-2' ? answer('', 1, 'no such gate') : undefined,
  )
  await run($, 'inbox')
  await run($, 'answer', 'g-1 A')
  await run($, 'answer', 'g-2 B')
  await settled()

  const dispatched = calls.filter(call => call.argv[0] === 'dispatch')
  expect(dispatched).toHaveLength(1)
  expect(dispatched[0]?.argv).toEqual(['dispatch', '--now'])
  expect(dispatched[0]?.env?.BEAD_INBOX_ID).toBe('g-1')
})

// ---- §9b: the real bd, and comments on stdin ----

const labelled = { ...gate('t-1', 'question'), issue_type: 'task' }

test('the real bd.exe comes first, and a multi-line answer goes whole on stdin', async ($, on) => {
  const calls = fakeRun(on, [labelled], call => (call.argv[1] === 'comments' && call.argv[2] === 't-1' ? answer('[]') : undefined))
  await run($, 'inbox')
  await run($, 'answer', 't-1 line one\nline "two" & 100%\nline ^three')

  const add = calls.find(call => call.argv[1] === 'comments' && call.argv[2] === 'add')
  expect(add?.argv).toEqual(['bd.exe', 'comments', 'add', 't-1', '-f', '-'])
  expect(add?.stdin).toBe('Human answer: line one\nline "two" & 100%\nline ^three')
})

test('with no bd.exe, plain bd is used', async ($, on) => {
  const calls = fakeRun(on, [gate('g-1')], call => {
    if (call.argv[0] === 'bd.exe') {
      return answer('', 1, 'not found')
    }
    if (call.argv[0] === 'where.exe') {
      return answer('', 1)
    }
    return undefined
  })
  await run($, 'inbox')

  expect(calls.filter(call => call.argv[1] === 'list').map(call => call.argv[0])).toEqual(['bd', 'bd'])
})

// ---- §10: the store signature ----

const fakeStore = (on: unknown) => {
  const store = { journal: 100, manifest: 'root-1', mtime: 1, present: true, paths: [] as string[] }
  const is = (path: string, tail: string) => {
    store.paths.push(path)
    return store.present && path.replace(/\\/g, '/').endsWith(`/.beads/${tail}`)
  }
  const root = '/store/.beads'
  mock.env(on as never, { BEADS_DIR: root })
  const missing = () => {
    throw new Error('ENOENT')
  }
  ;(on as Hook)('fs.list', async (_$: unknown, e: { path: string }) =>
    is(e.path, "embeddeddolt")
      ? { value: [{ name: 'db', kind: 'dir', size: 0, mtimeMs: 0, isLink: false }] }
      : missing(),
  )
  ;(on as Hook)('fs.read', async (_$: unknown, e: { path: string }) =>
    is(e.path, "embeddeddolt/db/.dolt/noms/manifest") ? { value: store.manifest } : missing(),
  )
  ;(on as Hook)('fs.stat', async (_$: unknown, e: { path: string }) =>
    is(e.path, `embeddeddolt/db/.dolt/noms/${"v".repeat(32)}`)
      ? { value: { kind: 'file', size: store.journal, mtimeMs: store.mtime, isLink: false } }
      : missing(),
  )

  return store
}

test('an unchanged store costs no bd call; a write costs exactly one refresh', async ($, on) => {
  host(on)
  const clock = mock.clock(on as never, { now: 1_000_000 })
  const store = fakeStore(on)
  const calls = fakeRun(on, [gate('g-1')])
  await start($, true)
  await clock.settle()
  expect(lists(calls)).toBe(2)

  await clock.advance(10_000)
  expect(lists(calls)).toBe(2)

  store.journal += 50
  await clock.advance(10_000)
  expect(lists(calls)).toBe(4)
  await clock.advance(10_000)
  expect(lists(calls)).toBe(4)

  // Reads touch modification times, never the signature.
  store.mtime += 1000
  await clock.advance(10_000)
  expect(lists(calls)).toBe(4)

  store.manifest = 'root-2'
  await clock.advance(10_000)
  expect(lists(calls)).toBe(6)
})

test('a write landing during a refresh causes one more refresh next poll', async ($, on) => {
  host(on)
  const clock = mock.clock(on as never, { now: 1_000_000 })
  const store = fakeStore(on)
  let writeDuringNextList = false
  const calls = fakeRun(on, [gate('g-1')], call => {
    if (call.argv[1] === 'list' && writeDuringNextList) {
      writeDuringNextList = false
      store.journal += 10
    }
    return undefined
  })
  await start($, true)
  await clock.settle()

  store.journal += 10
  writeDuringNextList = true
  await clock.advance(10_000)
  expect(lists(calls)).toBe(4)
  await clock.advance(10_000)
  expect(lists(calls)).toBe(6)
  await clock.advance(10_000)
  expect(lists(calls)).toBe(6)
})

test('with no store files polling falls back to a fixed minute', async ($, on) => {
  host(on)
  const clock = mock.clock(on as never, { now: 1_000_000 })
  const store = fakeStore(on)
  store.present = false
  const calls = fakeRun(on, [gate('g-1')])
  await start($, true)
  await clock.settle()
  expect(lists(calls)).toBe(2)

  await clock.advance(50_000)
  expect(lists(calls)).toBe(2)
  await clock.advance(10_000)
  expect(lists(calls)).toBe(4)
})
