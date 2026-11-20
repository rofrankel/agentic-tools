import { expect, test } from 'claude-code/testing'

const gate = (id: string, kind: string, project: string) => ({
  id,
  title: `Title ${id}`,
  status: 'open',
  issue_type: 'gate',
  await_type: 'human',
  created_at: '2026-10-30T00:00:00Z',
  labels: [`attn:${kind}`, `project:${project}`],
})

type Row = ReturnType<typeof gate>

const fakeBd = (on: never, rows: Row[], show?: unknown) => {
  const calls: string[][] = []
  ;(on as (event: string, hook: unknown) => void)('process.run', async (_$: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(1)
    calls.push(args)
    const answer = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args[0] === 'list') {
      return answer(JSON.stringify(rows))
    }
    if (args[0] === 'show') {
      return answer(JSON.stringify(show ?? [{ id: args[1], title: 'Work' }]))
    }
    return answer('')
  })

  return calls
}

type Ui = {
  find: (q: object) => Promise<unknown>
  findAll?: (q: object) => Promise<unknown[]>
  press: (q: object) => Promise<unknown>
  unmount: () => Promise<void>
}

const mount = ($: unknown, requestId = 'bead-inbox', surface = 'terminal') =>
  ($ as { ui: { mount: (target: object) => Promise<Ui> } }).ui.mount({
    plugin: 'bead-inbox',
    surface,
    component: 'Pane',
    requestId,
    props: {},
  })

const run = async ($: unknown, input: { command: string; args?: string }) =>
  ((await ($ as { command: { run: (input: object) => Promise<{ text?: string }> } }).command.run(input)).text ?? '')

const MIXED = [
  gate('web-1', 'decision', 'web'),
  gate('api-1', 'decision', 'web:api'),
  gate('app-1', 'question', 'webapp'),
  gate('cli-1', 'approval', 'cli'),
]

test('every item is drawn, however many there are', async ($, on) => {
  fakeBd(on as never, Array.from({ length: 10 }, (_, n) => gate(`p-${n}`, 'decision', 'api')))
  await run($, { command: 'inbox' })
  const ui = await mount($)

  for (let n = 0; n < 10; n += 1) {
    expect(await ui.find({ type: 'Text', text: new RegExp(`Title p-${n}$`) })).toBeDefined()
  }
  await ui.unmount()
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a project tag filters to that project and its subprojects; Clear shows all on ${surface}`, async ($, on) => {
    fakeBd(on as never, MIXED)
    await run($, { command: 'inbox' })
    const ui = await mount($, 'bead-inbox', surface)
    await ui.press({ key: 'web-1:tag' })

    expect(await ui.find({ type: 'Text', text: /^Filter: project web \(2 of 4\)$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Title api-1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Title app-1/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Title cli-1/ })).toBeUndefined()

    await ui.press({ key: 'filter:clear' })
    expect(await ui.find({ type: 'Text', text: /^Filter:/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /Title cli-1/ })).toBeDefined()
    await ui.unmount()
  })
}

test('/inbox replies with counts, filtered or not', async ($, on) => {
  fakeBd(on as never, MIXED)

  expect(await run($, { command: 'inbox' })).toContain('4 items need you')
  expect(await run($, { command: 'inbox', args: 'decision' })).toContain('2 of 4 items need you')
  const web = await run($, { command: 'inbox', args: 'project:web' })
  expect(web).toContain('2 of 4 items need you')
  expect(web).not.toContain('app-1')
  expect(await run($, { command: 'inbox', args: 'project:nowhere' })).toContain('Nothing matches the filter')
  const ui = await mount($)
  expect(await ui.find({ type: 'Text', text: /Nothing matches the filter/ })).toBeDefined()
  await ui.unmount()
  expect(await run($, { command: 'inbox', args: '' })).toContain('4 items need you')
})

test('a bare /inbox (no args field at all) still gets a reply', async ($, on) => {
  fakeBd(on as never, [])

  expect(await run($, { command: 'inbox' })).toBe('Nothing needs you.')
})

test('bare /approve, /answer, /reject and /inbox-open reply with their usage and write nothing', async ($, on) => {
  const calls = fakeBd(on as never, [])

  expect(await run($, { command: 'approve' })).toContain('Usage: /approve')
  expect(await run($, { command: 'answer', args: '   ' })).toContain('Usage: /answer')
  expect(await run($, { command: 'reject' })).toContain('Usage: /reject')
  expect(await run($, { command: 'inbox-open' })).toContain('Usage: /inbox-open')
  expect(calls.filter(one => one[0] !== 'version')).toEqual([])
})

test('a command that throws says which one and why', async ($, on) => {
  fakeBd(on as never, [])

  const text = await run($, { command: 'inbox-show', args: 42 as never })
  expect(text).toMatch(/^bead-inbox: \/inbox-show failed: .+/)
  expect(text).not.toContain('debug log')
})

test('the bead pane draws markdown links as links', async ($, on) => {
  fakeBd(on as never, [], [
    {
      id: 'w-1',
      title: 'Work',
      status: 'open',
      issue_type: 'task',
      description: 'Spec: [the doc](https://example.com/spec) for details.',
      comments: [{ author: 'agent', text: 'Posted [thread](https://example.com/t/1)', created_at: '2026-10-30T01:00:00Z' }],
    },
  ])
  await run($, { command: 'inbox-open', args: 'w-1' })
  const ui = await mount($, 'bead-w-1')

  expect(JSON.stringify(await ui.find({ type: 'Link', text: 'thread' }))).toContain('https://example.com/t/1')
  expect(JSON.stringify(await ui.find({ type: 'Link', text: 'the doc' }))).toContain('https://example.com/spec')
  expect(await ui.find({ type: 'Text', text: /\]\(https/ })).toBeUndefined()
  await ui.unmount()
})
