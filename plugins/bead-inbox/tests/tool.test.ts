import { expect, test } from 'claude-code/testing'

// The test environment has no processes, so bd cannot run: the plugin's own
// hook must still answer the call (with its bd error), never the engine's
// "no tool.call hook answered this call".
test('ask_human is answered by the plugin', async $ => {
  const answer = await $.tool.call({
    tool: 'mcp__bead-inbox__ask_human',
    kind: 'decision',
    question: 'Postgres or SQLite?',
  } as never)
  const text = JSON.stringify(answer)

  expect(text).not.toContain('no tool.call hook answered')
  expect(text).toContain('Could not file the question')
})

test('ask_human without a question is refused by the plugin', async $ => {
  const answer = await $.tool.call({ tool: 'mcp__bead-inbox__ask_human', kind: 'decision' } as never)

  expect(JSON.stringify(answer)).toContain('ask_human needs a question')
})

