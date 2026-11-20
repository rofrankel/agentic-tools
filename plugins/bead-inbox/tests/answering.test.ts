import { expect, mock, test } from 'claude-code/testing'

// A bd that keeps state: answered gates close, comments pile up, labels come
// off. `fail` makes chosen calls fail, time out (throw) or wait.
type Row = { id: string; title: string; status: string; issue_type: string; await_type?: string; created_at: string; labels: string[]; description?: string }
type Reply = { exitCode?: number; stdout?: string; stderr?: string } | 'throw' | Promise<unknown>
type Call = { argv: string[]; args: string[]; stdin?: string }

const gate = (id: string, kind: string, blocks?: string): Row => ({
  id,
  title: `Question ${id}?`,
  status: 'open',
  issue_type: 'gate',
  await_type: 'human',
  created_at: '2026-10-30T00:00:00Z',
  labels: [`attn:${kind}`],
  description: blocks ? `Ad-hoc gate blocking ${blocks}` : '',
})

const issue = (id: string, kind: string): Row => ({
  id,
  title: `Task ${id}`,
  status: 'open',
  issue_type: 'task',
  created_at: '2026-10-30T00:00:00Z',
  labels: [`attn:${kind}`],
})

// `unlisted` beads are in bd but not in its list output: what bd show finds
// for an id the poll hasn't seen.
const fakeBd = (on: never, rows: Row[], fail: (call: Call) => Reply | undefined = () => undefined, unlisted: Row[] = []) => {
  const calls: Call[] = []
  const comments = new Map<string, { text: string; created_at: string }[]>()
  ;(on as (event: string, hook: unknown) => void)('process.run', async (_$: unknown, e: { argv: string[]; init?: { stdin?: string } }) => {
    const call = { argv: [...e.argv], args: e.argv.slice(1), stdin: e.init?.stdin }
    calls.push(call)
    const answer = (r: { exitCode?: number; stdout?: string; stderr?: string }) => ({
      value: { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? '', stderr: r.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false },
    })
    const special = fail(call)
    if (special === 'throw') {
      throw new Error('timed out')
    }
    if (special instanceof Promise) {
      await special
    } else if (special) {
      return answer(special)
    }
    const [verb, sub, id] = call.args
    if (verb === 'list') {
      return answer({ stdout: JSON.stringify(rows.filter(one => one.status !== 'closed')) })
    }
    if (verb === 'close') {
      const row = [...rows, ...unlisted].find(one => one.id === sub)
      if (row) {
        row.status = 'closed'
      }
      return answer({})
    }
    if (verb === 'comments' && sub === 'add' && id) {
      comments.set(id, [...(comments.get(id) ?? []), { text: call.stdin ?? '', created_at: new Date().toISOString() }])
      return answer({})
    }
    if (verb === 'comments' && sub) {
      return answer({ stdout: JSON.stringify(comments.get(sub) ?? []) })
    }
    if (verb === 'label' && sub === 'remove') {
      const row = rows.find(one => one.id === id)
      if (row) {
        row.labels = row.labels.filter(label => label !== call.args[3])
      }
      return answer({})
    }
    if (verb === 'show') {
      const known = [...rows, ...unlisted].find(one => one.id === sub)
      return answer({ stdout: JSON.stringify([known ?? { id: sub, title: 'Work', status: 'open', issue_type: 'task', labels: [] }]) })
    }

    return answer({})
  })

  return { calls, comments }
}

const run = async ($: unknown, command: string, args?: string) =>
  ((await ($ as { command: { run: (input: object) => Promise<{ text?: string }> } }).command.run(
    args === undefined ? { command } : { command, args },
  )).text ?? '')

const { setTimeout: wait } = globalThis as unknown as { setTimeout: (fn: unknown, ms: number) => void }
const settled = () => new Promise(done => wait(done, 20))

const is = (call: Call, ...words: string[]) => words.every((word, n) => call.args[n] === word)
const PANE = { component: 'Pane', requestId: 'bead-inbox', props: {} }
const mount = ($: unknown) =>
  ($ as { ui: { mount: (target: object) => Promise<{ find: (q: object) => Promise<unknown>; press: (q: object) => Promise<unknown>; unmount: () => Promise<void> }> } }).ui.mount({
    plugin: 'bead-inbox',
    surface: 'terminal',
    ...PANE,
  })

test('a gate close that hits the lock is retried once and succeeds', async ($, on) => {
  let tries = 0
  const { calls } = fakeBd(on as never, [gate('g-1', 'decision')], call =>
    is(call, 'close') && (tries += 1) === 1 ? { exitCode: 1, stderr: 'Error: database is locked' } : undefined,
  )
  await run($, 'inbox')

  expect(await run($, 'answer', 'g-1 use A')).toContain('Resolved g-1')
  expect(calls.filter(call => is(call, 'close'))).toHaveLength(2)
})

test('a timed-out comment add is not retried blindly: the comments are read again first', async ($, on) => {
  let adds = 0
  const state = fakeBd(on as never, [issue('t-1', 'question')], call => {
    if (is(call, 'comments', 'add') && (adds += 1) === 1) {
      // The add landed, but bd's answer never came back.
      state.comments.set('t-1', [{ text: call.stdin ?? '', created_at: new Date().toISOString() }])
      return 'throw'
    }
    return undefined
  })
  await run($, 'inbox')
  const text = await run($, 'answer', 't-1 use A')

  const sequence = state.calls.filter(call => call.args[0] === 'comments').map(call => call.args[1])
  expect(sequence).toEqual(['t-1', 'add', 't-1'])
  expect(text).toContain('already saved')
})

test('the same answer twice within 2 minutes is saved once, and the reply says so', async ($, on) => {
  const { calls } = fakeBd(on as never, [issue('t-1', 'question')], call =>
    // The label won't come off, so the item comes back for a second try.
    is(call, 'label', 'remove') ? { exitCode: 1, stderr: 'database is busy' } : undefined,
  )
  await run($, 'inbox')
  await run($, 'answer', 't-1 use A')
  const second = await run($, 'answer', 't-1 use A')

  expect(calls.filter(call => is(call, 'comments', 'add'))).toHaveLength(1)
  expect(second).toContain('already saved')
})

test('a quick second answer to a hidden item is not saved twice', async ($, on) => {
  const { calls } = fakeBd(on as never, [issue('t-1', 'question')])
  await run($, 'inbox')
  await run($, 'answer', 't-1 use A')
  const second = await run($, 'answer', 't-1 use A')

  expect(calls.filter(call => is(call, 'comments', 'add'))).toHaveLength(1)
  expect(calls.filter(call => is(call, 'close'))).toHaveLength(0)
  expect(second).toContain('already saved')
})

test('a label that will not come off: answer saved, item back in place with the reason, retry redoes only the label', async ($, on) => {
  let removes = 0
  const { calls } = fakeBd(on as never, [gate('g-1', 'approval'), issue('t-1', 'question'), issue('t-2', 'question')], call =>
    is(call, 'label', 'remove') && (removes += 1) === 1 ? { exitCode: 1, stderr: 'database is busy' } : undefined,
  )
  await run($, 'inbox')
  const text = await run($, 'answer', 't-1 use A')

  expect(text).toContain('Answered t-1')
  expect(text).toContain("couldn't remove attn:question")
  expect(text).toContain('stays in the inbox')

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /Not saved: Answered t-1/ })).toBeDefined()
  const listed = await run($, 'inbox-list', 'answer')
  expect(listed.indexOf('t-1')).toBeLessThan(listed.indexOf('t-2'))
  await ui.unmount()

  // Well past the 2-minute window, the same answer still isn't added again.
  const before = calls.filter(call => is(call, 'comments', 'add')).length
  const again = await run($, 'answer', 't-1 use A')
  expect(calls.filter(call => is(call, 'comments', 'add'))).toHaveLength(before)
  expect(calls.filter(call => is(call, 'label', 'remove'))).toHaveLength(2)
  expect(again).toContain('Answered t-1')
})

test('a gate that resolves while its blocked-bead comment fails stays answered, with a note', async ($, on) => {
  fakeBd(on as never, [gate('g-1', 'decision', 'w-1')], call =>
    is(call, 'comments', 'add') ? { exitCode: 1, stderr: 'disk full' } : undefined,
  )
  await run($, 'inbox')
  const text = await run($, 'answer', 'g-1 use A')

  expect(text).toContain('Resolved g-1')
  expect(text).toContain("couldn't comment on w-1 (disk full)")
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /Question g-1/ })).toBeUndefined()
  await ui.unmount()
})

test('an answered item is gone at once, and stays gone while its write is held back', async ($, on) => {
  let release: () => void = () => undefined
  const held = new Promise<void>(done => {
    release = done
  })
  fakeBd(on as never, [gate('g-1', 'decision'), gate('g-2', 'decision')], call =>
    is(call, 'close') ? held : undefined,
  )
  await run($, 'inbox')
  const answering = run($, 'answer', 'g-1 use A')
  await settled()

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /Question g-1/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /Question g-2/ })).toBeDefined()
  // A refresh during the write still lists it: it stays hidden.
  await run($, 'inbox-list')
  expect(await ui.find({ type: 'Text', text: /Question g-1/ })).toBeUndefined()
  release()
  expect(await answering).toContain('Resolved g-1')
  await ui.unmount()
})

test('a failed answer puts the item back with "Not saved"', async ($, on) => {
  fakeBd(on as never, [gate('g-1', 'decision')], call =>
    is(call, 'close') ? { exitCode: 1, stderr: 'no such gate' } : undefined,
  )
  await run($, 'inbox')
  expect(await run($, 'answer', 'g-1 use A')).toContain('Could not resolve g-1')

  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /Question g-1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Not saved: Could not resolve g-1/ })).toBeDefined()
  await ui.unmount()
})

test('the stale-snapshot guard: hidden until a snapshot that began after the answer', { options: { snapshotCommand: 'snap' } }, async ($, on) => {
  mock.clock(on as never, { now: 1_800_000_000_000 })
  let started = 1_799_999_000
  const rows = [gate('g-1', 'decision')]
  ;(on as (event: string, hook: unknown) => void)('process.run', async (_$: unknown, e: { argv: string[] }) => {
    const answer = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (e.argv[0] === 'snap') {
      return answer(JSON.stringify({ gates: rows, attn: [], started }))
    }
    return answer('')
  })
  await run($, 'inbox')
  await run($, 'answer', 'g-1 use A')
  // The snapshot still lists it, from reads that began before the answer.
  expect(await run($, 'inbox-list')).not.toContain('g-1')
  started = 1_800_000_100
  expect(await run($, 'inbox-list')).toContain('g-1')
})

test('the pane Approve button toasts "saving…" and then the result', async ($, on) => {
  const toasts: string[] = []
  ;(on as (event: string, hook: unknown) => void)('ui.toast', async (_$: unknown, e: { text: string }) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  fakeBd(on as never, [gate('g-1', 'approval')])
  await run($, 'inbox')
  const ui = await mount($)
  await ui.press({ key: 'g-1:approve' })
  await settled()

  expect(toasts[0]).toBe('g-1: saving…')
  expect(toasts).toContain('Resolved g-1.')
  await ui.unmount()
})

test('two refreshes started together share one round of bd list calls', async ($, on) => {
  const { calls } = fakeBd(on as never, [gate('g-1', 'decision')])
  await Promise.all([run($, 'inbox'), run($, 'inbox-list')])

  expect(calls.filter(call => call.args[0] === 'list')).toHaveLength(2)
})

test("a multi-line gate answer reaches bd close whole, on stdin", async ($, on) => {
  const { calls } = fakeBd(on as never, [gate('g-1', 'decision', 'w-1')])
  await run($, 'inbox')
  const answer = 'use A\nbecause "B" & C cost 100% more ^ twice'
  await run($, 'answer', `g-1 ${answer}`)

  const close = calls.find(call => is(call, 'close'))
  expect(close?.args).toEqual(['close', 'g-1', '--reason-file', '-'])
  expect(close?.stdin).toBe(answer)
  expect(calls.find(call => is(call, 'comments', 'add', 'w-1'))?.stdin).toBe(`Human answer to g-1 (Question g-1?): ${answer}`)
})

test('an id typed by hand for ordinary work is not closed', async ($, on) => {
  const { calls } = fakeBd(on as never, [])
  const text = await run($, 'answer', 'task-9 done')

  expect(text).toContain('Nothing answered: task-9 is neither a human gate nor labelled attn:*')
  expect(calls.filter(call => is(call, 'close') || is(call, 'comments', 'add'))).toEqual([])
})

test('a gate the poll has not seen yet is looked up and answered', async ($, on) => {
  const { calls } = fakeBd(on as never, [], undefined, [gate('g-9', 'decision', 'w-9')])
  const text = await run($, 'answer', 'g-9 go')

  expect(text).toContain('Resolved g-9')
  expect(calls.find(call => is(call, 'close'))?.stdin).toBe('go')
  expect(calls.find(call => is(call, 'comments', 'add', 'w-9'))).toBeDefined()
})

test('a closed gate typed by hand says so and writes nothing', async ($, on) => {
  const closed = { ...gate('g-8', 'decision'), status: 'closed' }
  const { calls } = fakeBd(on as never, [], undefined, [closed])

  expect(await run($, 'answer', 'g-8 go')).toContain('Nothing answered: g-8 is already closed')
  expect(calls.filter(call => is(call, 'close'))).toEqual([])
})
