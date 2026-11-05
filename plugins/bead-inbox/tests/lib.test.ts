import { expect, test } from 'claude-code/testing'

import { age, chipText, cleanProject, createdId, folderName, isFeedbackKind, isMixed, isRepeat, mightHoldQuestions, paneIdFor, parseBead, parseExtracted, parseGates, projectColors, projectOf, quickId, sameQuestion, splitIdAndText, statusText } from '../hooks/lib'

// Shaped as `bd list --type gate --status open --json` prints (bd 1.3.2).
const BD_LIST = JSON.stringify([
  {
    id: 'proj-3l4',
    title: 'Postgres vs SQLite for the cache?',
    description: 'Ad-hoc gate blocking proj-a7j\n\nReason: A) Postgres. B) SQLite. Recommend B.',
    status: 'open',
    issue_type: 'gate',
    created_at: '2026-10-30T03:41:18Z',
    labels: ['attn:decision'],
    await_type: 'human',
  },
  {
    id: 'proj-9zz',
    title: 'Gate: human',
    description: 'Ship release 2.0',
    status: 'open',
    issue_type: 'gate',
    created_at: '2026-10-30T01:00:00Z',
    await_type: 'human',
  },
  {
    id: 'proj-t1m',
    title: 'Gate: timer',
    status: 'open',
    issue_type: 'gate',
    created_at: '2026-10-30T01:00:00Z',
    await_type: 'timer',
  },
])

test('bd gates become inbox items, approvals first, timers left out', async () => {
  const list = parseGates(BD_LIST)

  expect(list.map(one => one.id)).toEqual(['proj-9zz', 'proj-3l4'])
  expect(list[0]?.kind).toBe('approval')
  expect(list[1]).toEqual({
    id: 'proj-3l4',
    title: 'Postgres vs SQLite for the cache?',
    kind: 'decision',
    details: 'A) Postgres. B) SQLite. Recommend B.',
    blocks: 'proj-a7j',
    createdAt: '2026-10-30T03:41:18Z',
    isGate: true,
    label: 'attn:decision',
    project: 'proj',
  })
})

test('ordinary issues with an attn: label show too, a labelled gate once', async () => {
  const labelled = JSON.stringify([
    {
      id: 'proj-q23',
      title: 'Pick a logging lib',
      status: 'in_progress',
      issue_type: 'task',
      created_at: '2026-10-30T02:00:00Z',
      labels: ['attn:question', 'backend'],
    },
    {
      id: 'proj-3l4',
      title: 'Postgres vs SQLite for the cache?',
      description: 'Ad-hoc gate blocking proj-a7j',
      status: 'open',
      issue_type: 'gate',
      created_at: '2026-10-30T03:41:18Z',
      labels: ['attn:decision'],
    },
    { id: 'proj-x', title: 'unlabelled', status: 'open', issue_type: 'task', created_at: '2026-10-30T00:00:00Z' },
  ])
  const list = parseGates(BD_LIST, labelled)

  expect(list.map(one => one.id)).toEqual(['proj-9zz', 'proj-3l4', 'proj-q23'])
  expect(list[2]).toMatchObject({ kind: 'question', isGate: false, label: 'attn:question' })
})

test('the status line counts each kind and clears when empty', async () => {
  expect(statusText(parseGates(BD_LIST))).toBe('⚑ 2 need you · 1 approve · 1 decide')
  expect(statusText([])).toBeUndefined()
})

test('command arguments split into id and text', async () => {
  expect(splitIdAndText(' proj-3l4  B, keep TTL 5m ')).toEqual({ id: 'proj-3l4', text: 'B, keep TTL 5m' })
  expect(splitIdAndText('proj-3l4')).toEqual({ id: 'proj-3l4', text: '' })
  expect(splitIdAndText('   ')).toBeUndefined()
})

test('extracted questions are read from a reply with prose around the JSON', async () => {
  const reply = 'Here you go:\n[{"kind":"approval","question":"Delete the old table?","details":"It holds 2GB"},{"kind":"bogus","question":"Which port?"},{"question":""}]'

  expect(parseExtracted(reply)).toEqual([
    { kind: 'approval', question: 'Delete the old table?', details: 'It holds 2GB' },
    { kind: 'question', question: 'Which port?', details: '' },
  ])
  expect(parseExtracted('nothing here')).toEqual([])
})

test('ages read in minutes, hours, then days', async () => {
  const at = Date.parse('2026-10-30T12:00:00Z')

  expect(age('2026-10-30T11:15:00Z', at)).toBe('45m')
  expect(age('2026-10-30T07:00:00Z', at)).toBe('5h')
  expect(age('2026-10-27T12:00:00Z', at)).toBe('3d')
})

test('pane ids keep to the allowed characters', async () => {
  expect(paneIdFor('proj-a1b2.1')).toBe('bead-proj-a1b2_1')
})

test('a bead, its comments and the bead a gate blocks read from one bd show', async () => {
  const show = JSON.stringify([
    {
      id: 'proj-3l4',
      title: 'Postgres vs SQLite?',
      status: 'open',
      issue_type: 'gate',
      priority: 2,
      owner: 'richard@frankel.tv',
      labels: ['attn:decision'],
      created_at: '2026-10-30T03:41:18Z',
      updated_at: '2026-10-30T03:41:18Z',
      description: 'Ad-hoc gate blocking proj-a7j\n\nReason: A or B',
      notes: '  ',
      dependencies: [{ id: 'proj-zz', title: 'Spike', status: 'closed', issue_type: 'task' }],
      comments: [{ id: 'c1', issue_id: 'proj-3l4', author: 'Richard', text: 'leaning B', created_at: '2026-10-30T04:00:00Z' }],
    },
    { id: 'proj-a7j', title: 'Cache layer', status: 'blocked', issue_type: 'task', description: 'Build it' },
  ])
  const view = parseBead(show, 'proj-3l4', 'proj-a7j')

  expect(view?.sections).toEqual([{ heading: 'Description', text: 'Ad-hoc gate blocking proj-a7j\n\nReason: A or B' }])
  expect(view?.assignee).toBe('richard@frankel.tv')
  expect(view?.deps).toEqual([{ id: 'proj-zz', title: 'Spike', status: 'closed', type: 'task' }])
  expect(view?.comments).toEqual([{ author: 'Richard', text: 'leaning B', createdAt: '2026-10-30T04:00:00Z' }])
  expect(view?.blocks).toEqual({ id: 'proj-a7j', title: 'Cache layer', status: 'blocked', type: 'task', description: 'Build it' })
  // Without the target passed in, it is found from the gate's description.
  expect(parseBead(show, 'proj-3l4')?.blocks?.id).toBe('proj-a7j')
  expect(parseBead('[]', 'proj-3l4')).toBeUndefined()
})

test('bd output is read through notices printed around the JSON', async () => {
  const noisy = 'Note: a newer bd is available\n{\n  "id": "proj-9k2",\n  "title": "Q"\n}\nSynced.'

  expect(createdId(noisy)).toBe('proj-9k2')
  expect(createdId('[{"id":"proj-1"}]')).toBe('proj-1')
  expect(quickId('Warning: auto-sync off\nproj-a7j\n')).toBe('proj-a7j')
  expect(quickId('proj-a1b2.1')).toBe('proj-a1b2.1')
  expect(parseGates(`hint: run bd doctor\n${BD_LIST}`).length).toBe(2)
})

test('closed beads stay only when labelled for review or feedback; closed gates do not', async () => {
  const list = parseGates(
    JSON.stringify([
      { id: 'p-1', title: 'Done work', status: 'closed', issue_type: 'task', created_at: '2026-10-30T00:00:00Z', labels: ['attn:review'] },
      { id: 'p-2', title: 'Old gate', status: 'closed', issue_type: 'gate', created_at: '2026-10-30T00:00:00Z', await_type: 'human' },
      { id: 'p-3', title: 'Settled question', status: 'closed', issue_type: 'task', created_at: '2026-10-30T00:00:00Z', labels: ['attn:question'] },
      { id: 'p-4', title: 'Settled decision', status: 'closed', issue_type: 'task', created_at: '2026-10-30T00:00:00Z', labels: ['attn:decision'] },
    ]),
  )

  expect(list.map(one => [one.id, one.kind])).toEqual([['p-1', 'review']])
  expect(isFeedbackKind('review') && isFeedbackKind('feedback') && !isFeedbackKind('decision')).toBe(true)
  expect(sameQuestion('  Postgres  or SQLite? ', 'postgres or sqlite?')).toBe(true)
})

const gate = (id: string, labels: string[]) => ({
  id,
  title: 'Merge to main?',
  status: 'open',
  issue_type: 'gate',
  created_at: '2026-10-30T00:00:00Z',
  labels,
})

test('a bead belongs to its project: label, or else its id prefix', async () => {
  expect(projectOf('todo-3l4', ['attn:decision', 'project:billing'])).toBe('billing')
  expect(projectOf('my-app-a1b2.1', ['attn:decision'])).toBe('my-app')
  expect(projectOf('odd', [])).toBe('odd')
})

test('project tags show only when the inbox holds more than one project', async () => {
  const one = parseGates(JSON.stringify([gate('p-1', ['attn:decision']), gate('p-2', ['attn:question'])]))
  const two = parseGates(JSON.stringify([gate('p-1', ['project:api']), gate('p-2', ['project:web'])]))

  expect(isMixed(one)).toBe(false)
  expect(isMixed(two)).toBe(true)
  expect(isMixed([])).toBe(false)
})

test('project names are made safe for a bd label', async () => {
  expect(cleanProject(' My App,v2 ')).toBe('my-app-v2')
  expect(cleanProject('project:Billing')).toBe('billing')
  expect(cleanProject('  ')).toBeUndefined()
  expect(cleanProject(undefined)).toBeUndefined()
  expect(folderName('C:\\Users\\richard\\dev\\agentic-tools\\')).toBe('agentic-tools')
  expect(folderName('/home/r/todo')).toBe('todo')
  expect(folderName('/')).toBeUndefined()
})

test('projects on screen never share a color, and a name alone picks the same one each time', async () => {
  const names = Array.from({ length: 12 }, (_, n) => `project-${n}`)
  const colorOf = projectColors(names)

  expect(new Set(names.map(colorOf)).size).toBe(12)
  expect(colorOf('project-3')).toMatch(/^#[0-9a-f]{6}$/)
  // The order the rows arrive in does not matter.
  expect(projectColors([...names].reverse())('project-3')).toBe(colorOf('project-3'))
  expect(projectColors([])('billing')).toBe(projectColors(['billing'])('billing'))
  // More projects than colors still draws.
  expect(projectColors([...names, 'one-more'])('one-more')).toMatch(/^#[0-9a-f]{6}$/)
})

test('names spread across the colors', async () => {
  const alone = Array.from({ length: 200 }, (_, n) => projectColors([])(`p${n}`))

  expect(new Set(alone).size).toBe(12)
  expect(chipText('a-very-long-project-name')).toBe(' a-very-long-pro… ')
})

test('the same question from another project is not a retry', async () => {
  const [item] = parseGates(JSON.stringify([gate('p-1', ['project:api'])]))
  if (!item) {
    throw new Error('no item')
  }

  expect(isRepeat(item, ' merge to  main? ', 'api')).toBe(true)
  expect(isRepeat(item, 'Merge to main?', 'web')).toBe(false)
  expect(isRepeat(item, 'Merge to main?', undefined)).toBe(true)
  expect(isRepeat(item, 'Something else?', 'api')).toBe(false)
})

test('a report saying "User questions: none" is not mined for questions', async () => {
  const report = 'Done: bd-12.\n\nManager notes:\n- merge?\n- push?\n\nUser questions: none'

  expect(mightHoldQuestions(report)).toBe(false)
  expect(mightHoldQuestions('Manager notes: merge?\n**User questions:** None.')).toBe(false)
  expect(mightHoldQuestions('Manager notes: merge?\nUser questions:\n- Postgres or SQLite?')).toBe(true)
  expect(mightHoldQuestions('Should I delete the old table?')).toBe(true)
})
