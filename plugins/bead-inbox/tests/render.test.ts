import { expect, test } from 'claude-code/testing'

// The inbox as bd would list it: the test's process.run hook stands in for bd,
// which is how these reach the plugin's real refresh, filing and drawing.
const bead = (id: string, title: string, labels: string[]) => ({
  id,
  title,
  status: 'open',
  issue_type: 'gate',
  await_type: 'human',
  created_at: '2026-10-30T00:00:00Z',
  labels: ['attn:decision', ...labels],
})

type Row = ReturnType<typeof bead>

const fakeBd = (on: never, rows: Row[], shown: Record<string, string[]> = {}) => {
  const calls: string[][] = []
  ;(on as (event: string, hook: unknown) => void)('process.run', async (_$: unknown, e: { argv: string[] }) => {
    const args = e.argv.slice(1)
    calls.push(args)
    const answer = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (args[0] === 'list') {
      return answer(JSON.stringify(rows))
    }
    if (args[0] === 'show') {
      return answer(JSON.stringify([{ id: args[1], title: 'Work', labels: shown[args[1] ?? ''] ?? [] }]))
    }
    if (args[0] === 'gate') {
      return answer('{"id":"new-gate"}')
    }
    if (args[0] === 'q') {
      return answer('new-bead\n')
    }

    return answer('')
  })

  return calls
}

const ask = (fields: Record<string, string>) => ({ tool: 'mcp__bead-inbox__ask_human', kind: 'decision', ...fields }) as never

// Filing ends with a background refresh: let it finish inside the test.
const { setTimeout: wait } = globalThis as unknown as { setTimeout: (fn: unknown, ms: number) => void }
const settled = () => new Promise(done => wait(done, 20))

const labelCall = (calls: string[][]) => calls.find(one => one[0] === 'label' && one[1] === 'add')

test('a filed question takes the project the agent names', async ($, on) => {
  const calls = fakeBd(on as never, [])
  await $.tool.call(ask({ question: 'Which port?', project: 'Billing API' }))

  expect(calls.find(one => one[0] === 'q')).toContain('project:billing-api')
  expect(labelCall(calls)).toEqual(['label', 'add', 'new-gate', 'attn:decision,project:billing-api'])
  await settled()
})

test("the blocked bead's project wins over the one the agent names", async ($, on) => {
  const calls = fakeBd(on as never, [], { 'work-1': ['project:api'] })
  await $.tool.call(ask({ question: 'Which port?', blocks: 'work-1', project: 'web' }))

  expect(labelCall(calls)).toEqual(['label', 'add', 'new-gate', 'attn:decision,project:api'])
  await settled()
})

test('the same question from a second project is filed, from the same project is not', async ($, on) => {
  const calls = fakeBd(on as never, [bead('p-1', 'Merge to main?', ['project:api'])])
  const again = await $.tool.call(ask({ question: 'Merge to main?', project: 'api' }))

  expect(JSON.stringify(again)).toContain('Already in the human')
  expect(labelCall(calls)).toBeUndefined()

  await $.tool.call(ask({ question: 'Merge to main?', project: 'web' }))
  expect(labelCall(calls)).toEqual(['label', 'add', 'new-gate', 'attn:decision,project:web'])
  await settled()
})

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } }
const PANE = { component: 'Pane', requestId: 'bead-inbox', props: {} }

for (const surface of ['terminal', 'desktop'] as const) {
  test(`a mixed inbox tags each row with its project on ${surface}`, async ($, on) => {
    fakeBd(on as never, [bead('p-1', 'First?', ['project:api']), bead('p-2', 'Second?', ['project:web'])])
    await $.tool.call(ask({ question: 'First?', project: 'api' }))

    for (const target of [BAND, PANE]) {
      const ui = await $.ui.mount({ plugin: 'bead-inbox', surface, ...target } as never)
      const api = await ui.find({ type: 'Text', text: /^ api $/ } as never)
      const web = await ui.find({ type: 'Text', text: /^ web $/ } as never)

      expect(JSON.stringify(api)).toContain('backgroundColor')
      expect(JSON.stringify(web)).toContain('backgroundColor')
      expect(JSON.stringify(api)).not.toBe(JSON.stringify(web).replace(/ web /g, ' api '))
      await ui.unmount()
    }
  })

  test(`a one-project inbox shows no tags on ${surface}`, async ($, on) => {
    fakeBd(on as never, [bead('p-1', 'First?', ['project:api']), bead('p-2', 'Second?', ['project:api'])])
    await $.tool.call(ask({ question: 'First?', project: 'api' }))

    for (const target of [BAND, PANE]) {
      const ui = await $.ui.mount({ plugin: 'bead-inbox', surface, ...target } as never)

      expect(await ui.find({ type: 'Text', text: /^ api $/ } as never)).toBeUndefined()
      expect(await ui.find({ type: 'Text', text: /First\?/ } as never)).toBeDefined()
      await ui.unmount()
    }
  })
}
