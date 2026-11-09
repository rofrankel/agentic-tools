import { expect, test } from 'claude-code/testing'

// The text commands, as a Remote Control client would run them: no pane or
// band to read, only the reply. The process.run hook stands in for bd.
const gate = (id: string, title: string, kind: string, project: string, description = '') => ({
  id,
  title,
  description,
  status: 'open',
  issue_type: 'gate',
  await_type: 'human',
  created_at: '2026-10-30T00:00:00Z',
  labels: [`attn:${kind}`, `project:${project}`],
})

const INBOX = [
  gate('api-1', 'Ship 2.0?', 'approval', 'api', 'Ad-hoc gate blocking api-9\n\nReason: Tests pass. Recommend yes.'),
  gate('api-2', 'Postgres or SQLite?', 'decision', 'api'),
  gate('web-1', 'Which font?', 'question', 'web', 'Ad-hoc gate blocking web-5\n\nReason: Inter or Lato.'),
]

const fakeBd = (on: never) => {
  const calls: string[][] = []
  ;(on as (event: string, hook: unknown) => void)('process.run', async (_$: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(1)
    calls.push(args)
    const answer = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args[0] === 'list') {
      return answer(JSON.stringify(INBOX))
    }
    if (args[0] === 'show') {
      return answer(JSON.stringify([
        {
          ...INBOX[0],
          comments: [{ author: 'agent', text: 'Release notes are drafted.', created_at: '2026-10-30T01:00:00Z' }],
        },
        { id: 'api-9', title: 'Release 2.0', status: 'open', issue_type: 'task', description: 'Cut the tag.' },
      ]))
    }

    return answer('')
  })

  return calls
}

// Answering ends with a background refresh: let it finish inside the test.
const { setTimeout: wait } = globalThis as unknown as { setTimeout: (fn: unknown, ms: number) => void }
const settled = () => new Promise(done => wait(done, 20))

const run = async ($: { command: { run: (input: { command: string; args?: string }) => Promise<{ text?: string }> } }, command: string, args = '') =>
  (await $.command.run({ command, args })).text ?? ''

test('/inbox replies with the list, not just a count', async ($, on) => {
  fakeBd(on as never)
  const text = await run($ as never, 'inbox')

  expect(text).toContain('3 items need you')
  expect(text).toContain('APPROVE (1)')
  expect(text).toContain('api-1  [api] Ship 2.0? → api-9')
  expect(text).not.toContain('Tests pass')
})

test('/inbox-list shows details and narrows to a kind or a project', async ($, on) => {
  fakeBd(on as never)

  expect(await run($ as never, 'inbox-list')).toContain('Tests pass. Recommend yes.')

  const decisions = await run($ as never, 'inbox-list', 'decide')
  expect(decisions).toContain('api-2')
  expect(decisions).not.toContain('api-1')

  const web = await run($ as never, 'inbox-list', 'project:web')
  expect(web).toContain('web-1')
  expect(web).not.toContain('api-2')

  expect(await run($ as never, 'inbox-list', 'nonsense')).toContain('neither a kind')
})

test('/inbox-search finds items holding every word', async ($, on) => {
  fakeBd(on as never)

  const found = await run($ as never, 'inbox-search', 'inter FONT')
  expect(found).toContain('web-1')
  expect(found).not.toContain('api-')
  expect(await run($ as never, 'inbox-search', 'kubernetes')).toContain('No inbox item matches')
  expect(await run($ as never, 'inbox-search')).toContain('Usage')
})

test('/inbox-show prints the bead, what it blocks, its comments and how to reply', async ($, on) => {
  const calls = fakeBd(on as never)
  await run($ as never, 'inbox')
  const text = await run($ as never, 'inbox-show', 'api-1')

  expect(calls.find(one => one[0] === 'show')).toEqual(['show', 'api-1', 'api-9', '--include-comments', '--json'])
  expect(text).toContain('Ship 2.0? (api-1)')
  expect(text).toContain('Blocks: api-9 Release 2.0')
  expect(text).toContain('Release notes are drafted.')
  expect(text).toContain('/approve api-1')
})

test('an id works without its prefix', async ($, on) => {
  const calls = fakeBd(on as never)

  expect(await run($ as never, 'inbox-show', '1')).toContain('could be api-1 or web-1')

  const text = await run($ as never, 'inbox-show', '2')
  expect(text).toContain('/answer api-2')

  await run($ as never, 'approve', '2 looks good')
  expect(calls.find(one => one[0] === 'gate' && one[1] === 'resolve')?.slice(0, 3)).toEqual(['gate', 'resolve', 'api-2'])
  await settled()
})

test('/inbox-dismiss resolves the gate for the agent to judge', async ($, on) => {
  const calls = fakeBd(on as never)
  await run($ as never, 'inbox')
  const text = await run($ as never, 'inbox-dismiss', 'api-2')

  expect(text).toContain('Resolved api-2')
  expect(calls.find(one => one[0] === 'gate' && one[1] === 'resolve')?.slice(0, 4)).toEqual([
    'gate', 'resolve', 'api-2', '--reason',
  ])
  await settled()
})

test('/inbox-help lists the commands as text', async ($, on) => {
  fakeBd(on as never)
  const text = await run($ as never, 'inbox-help')

  expect(text).toContain('/inbox-search <words>')
  expect(text).toContain('/inbox-dismiss <id>')
})
