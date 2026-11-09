import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { AttnItem, AttnKind, BeadView } from '../types'
import {
  CHIP_TEXT,
  COLOR,
  HELP,
  KINDS,
  TAG,
  age,
  beadText,
  chipText,
  filterItems,
  listText,
  searchItems,
  cleanProject,
  folderName,
  isFeedbackKind,
  isKind,
  isMixed,
  isRepeat,
  labelledProject,
  mightHoldQuestions,
  parseExtracted,
  parseGates,
  projectColors,
  projectLabel,
  projectOf,
  splitIdAndText,
  statusText,
  truncate,
  createdId,
  gateTarget,
  quickId,
  paneIdFor,
  parseBead,
} from './lib'

const PLUGIN = 'bead-inbox'
const PANE = 'bead-inbox'
const HELP_PANE = 'bead-inbox-help'
const TOOL = 'ask_human'
const TOOL_ID = 'mcp__bead-inbox__ask_human'
const FEEDBACK_LABEL = 'human-feedback'
const POLL_MS = 15_000
const BAND_ROWS = 3
const DISMISSED = 'Dismissed by the human without an answer; use your judgment.'

const items = atom({ plugin: 'bead-inbox', key: 'items' } as const, [])
const error = atom({ plugin: 'bead-inbox', key: 'error' } as const, null)
const now = atom({ plugin: 'bead-inbox', key: 'now' } as const, 0)
const views = atom({ plugin: 'bead-inbox', key: 'views' } as const, {})
const loading = atom({ plugin: 'bead-inbox', key: 'loading' } as const, [])

const GUIDANCE = `Human attention inbox (bead-inbox plugin): whenever you need a decision, approval, answer, review or feedback from the human, call the ${TOOL_ID} tool instead of only writing the question in prose. Prose questions scroll out of sight during long autonomous runs; the tool puts them in a persistent inbox the human sees. Call it once per distinct question and never retry a call that returned a result. Pass \`blocks\` with the bead the question concerns when there is one, and \`project\` when the work belongs to a project other than the session's folder. Decisions, approvals and questions become a beads human gate blocking that bead: do not wait, carry on with other ready work; the answer arrives as the gate's close reason and as a comment on the blocked bead. Review and feedback block nothing: they label the bead attn:review or attn:feedback. When the human responds, their notes are a comment on the bead and it carries the ${FEEDBACK_LABEL} label (reopened if it was closed): address the notes, then remove that label (\`bd label remove <id> ${FEEDBACK_LABEL}\`). Check \`bd list --label ${FEEDBACK_LABEL}\` for feedback still to address. When relaying a subagent's questions, file each one with the tool unless the subagent already did.`

const SUBAGENT_GUIDANCE = `

---
If you need a decision, approval, answer, review or feedback from the human, call the ${TOOL_ID} tool (one call per question, never retried, with your options and recommendation in \`details\`, and \`blocks\` set to the bead your task is on if you know it), then finish whatever work does not depend on the answer. A bead labelled ${FEEDBACK_LABEL} has human notes in its comments: address them, then remove that label.`

const EXTRACT_SYSTEM = `You read a report a coding subagent handed back to its manager and list every point where it needs a HUMAN to act: a decision, an approval, a question only the human can answer, a review, or feedback. Ignore rhetorical questions, questions the report answers itself, and routine next steps the manager can decide alone. Reply with a JSON array only, no prose: [{"kind":"decision|approval|question|review|feedback","question":"one line","details":"the context, options and any recommendation, in the report's words"}]. Reply [] when there is nothing.`

type Engine = EngineInterface
type AskInput = { kind?: string; question?: string; details?: string; blocks?: string; project?: string }

let bdArgv: string[] | null = null
let seen: Set<string> | null = null
let sessionFolder: string | undefined
const askedBy = new Map<string, string>()
const filedBy = new Set<string>()

// The Bash tool finds bd through a shell; a shell-less run cannot start an
// npm .cmd shim, so look for the real binary once.
const findBd = async ($: Engine): Promise<string[] | null> => {
  const tryRun = async (argv: string[]) => {
    try {
      const r = await $.process.run([...argv, 'version'], { timeoutMs: 10_000 })
      return r.exitCode === 0
    } catch {
      return false
    }
  }
  for (const candidate of [['bd'], ['bd.exe']]) {
    if (await tryRun(candidate)) {
      return candidate
    }
  }
  try {
    const where = await $.process.run(['where.exe', 'bd'], { timeoutMs: 10_000 })
    for (const line of where.stdout.split(/\r?\n/).map(one => one.trim()).filter(Boolean)) {
      const dir = line.replace(/[\\/][^\\/]+$/, '')
      for (const exe of [
        line.endsWith('.exe') ? line : `${line}.exe`,
        `${dir}\\node_modules\\@beads\\bd\\bin\\bd.exe`,
      ]) {
        if (await tryRun([exe])) {
          return [exe]
        }
      }
    }
  } catch {
    // not Windows, or where.exe missing: nothing more to try
  }

  return null
}

const bd = async ($: Engine, args: string[]) => {
  bdArgv ??= await findBd($)
  if (bdArgv === null) {
    return { exitCode: 127, stdout: '', stderr: 'bd not found on PATH' }
  }

  return $.process.run([...bdArgv, ...args], { timeoutMs: 30_000 })
}

const refresh = async ($: Engine) => {
  const gates = await bd($, ['list', '--type', 'gate', '--status', 'open', '--json', '--limit', '0'])
  const labelled = await bd($, [
    'list', '--status', 'open,in_progress,blocked,closed', '--label-pattern', 'attn:*', '--json', '--limit', '0',
  ])
  await update($, now, () => Date.now())
  const broken = [gates, labelled].find(r => r.exitCode !== 0)
  if (broken) {
    const isNoDb = /no beads database/i.test(broken.stderr)
    const message = isNoDb
      ? `No beads database found from ${await $.session.cwd()}. Start Claude Code in the project repo (or set BEADS_DIR).`
      : `bd failed: ${truncate(broken.stderr.trim(), 300)}`
    await update($, items, () => [])
    await update($, error, () => message)
    $.ui.status(isNoDb ? undefined : '⚑ inbox: bd failed (see /inbox)')

    return
  }
  let list: AttnItem[]
  try {
    list = parseGates(gates.stdout, labelled.stdout)
  } catch {
    await update($, error, () => 'could not parse bd output')

    return
  }
  await update($, items, () => list)
  await update($, error, () => null)
  $.ui.status(statusText(list))

  const fresh = seen === null ? [] : list.filter(one => !seen?.has(one.id))
  seen = new Set(list.map(one => one.id))
  const [first] = fresh
  if (fresh.length === 1 && first) {
    const where = isMixed(list) ? ` in ${first.project}` : ''
    $.ui.toast(`⚑ New ${first.kind}${where}: ${truncate(first.title, 70)} (${first.id})`, {
      timeoutMs: 8000,
    })
  } else if (fresh.length > 1) {
    $.ui.toast(`⚑ ${fresh.length} new items need you · /inbox`, { timeoutMs: 8000 })
  }
}

// The bead's own tag wins, so filing never gives a bead a second project.
const projectFor = async ($: Engine, blocks: string | undefined, asked: string | undefined) => {
  if (blocks) {
    const show = await bd($, ['show', blocks, '--json'])
    try {
      const tagged = show.exitCode === 0 ? labelledProject(parseBead(show.stdout, blocks)?.labels ?? []) : undefined
      if (tagged) {
        return tagged
      }
    } catch {
      // unreadable bd output: fall back to the name
    }
  }

  return cleanProject(asked) ?? cleanProject(sessionFolder)
}

const fileGate = async (
  $: Engine,
  kind: AttnKind,
  question: string,
  details: string,
  blocks: string | undefined,
  source: string | undefined,
  project: string | undefined,
): Promise<{ id: string; blocks: string; isGate: boolean } | { error: string }> => {
  const tag = project ? [projectLabel(project)] : []
  const labels = [`attn:${kind}`, ...tag].join(',')
  let target = blocks?.trim()
  if (!target) {
    const q = await bd($, ['q', `Follow up: ${truncate(question, 100)}`, ...tag.flatMap(one => ['--labels', one])])
    if (q.exitCode !== 0) {
      return { error: q.stderr.trim() || 'bd q failed' }
    }
    const quick = quickId(q.stdout)
    if (!quick) {
      return { error: `bd q printed no id: ${truncate(q.stdout.trim(), 200)}` }
    }
    target = quick
  }
  const reason = [details.trim(), source ? `Asked by: ${source}` : ''].filter(Boolean).join('\n\n')

  // Review and feedback hold nothing up: they go on the work bead itself, so
  // the human's notes land where the agent will act on them.
  if (isFeedbackKind(kind)) {
    const c = await bd($, ['comments', 'add', target, `Human ${kind} requested: ${question}${reason ? `\n\n${reason}` : ''}`])
    if (c.exitCode !== 0) {
      return { error: c.stderr.trim() || 'bd comments add failed' }
    }
    await bd($, ['label', 'add', target, labels])

    return { id: target, blocks: target, isGate: false }
  }

  const created = await bd($, [
    'gate', 'create',
    '--type', 'human',
    '--blocks', target,
    '--title', truncate(question.replace(/\s+/g, ' '), 160),
    '--reason', reason || question,
    '--json',
  ])
  if (created.exitCode !== 0) {
    return { error: created.stderr.trim() || 'bd gate create failed' }
  }
  const id = createdId(created.stdout)
  if (!id) {
    return { error: `the gate may have been created, but bd printed no id (check /inbox before retrying): ${truncate(created.stdout.trim(), 200)}` }
  }
  await bd($, ['label', 'add', id, labels])

  return { id, blocks: target, isGate: true }
}

// Leaves the human's review or feedback on the work bead for the agent to
// address: a comment, the human-feedback label in place of the attn: one, and
// the bead reopened when it was closed so it shows in bd ready again.
const leaveFeedback = async ($: Engine, beadId: string, kind: AttnKind, notes: string, attnLabel?: string) => {
  const c = await bd($, ['comments', 'add', beadId, `Human ${kind}: ${notes}`])
  if (c.exitCode !== 0) {
    return `Could not comment on ${beadId}: ${c.stderr.trim()}`
  }
  if (attnLabel) {
    await bd($, ['label', 'remove', beadId, attnLabel])
  }
  await bd($, ['label', 'add', beadId, FEEDBACK_LABEL])
  const show = await bd($, ['show', beadId, '--json'])
  if (show.exitCode === 0 && /"status":\s*"closed"/.test(show.stdout)) {
    await bd($, ['reopen', beadId])
  }

  return undefined
}

const feedbackContext = (beadId: string, kind: AttnKind, title: string, notes: string) =>
  `[bead-inbox] The human left ${kind} on ${beadId}${title}: ${notes}. It is a comment on ${beadId}, which is labelled ${FEEDBACK_LABEL} (and reopened if it was closed). Address it, then remove the ${FEEDBACK_LABEL} label.`

const resolve = async ($: Engine, id: string, answer: string) => {
  const list = await read($, items)
  const item = list.find(one => one.id === id)
  const title = item ? ` ("${truncate(item.title, 80)}")` : ''

  if (item && isFeedbackKind(item.kind)) {
    // An older review/feedback gate still has to close to unblock its bead;
    // the notes go on that bead either way.
    const target = item.isGate ? item.blocks : item.id
    if (item.isGate) {
      const r = await bd($, ['gate', 'resolve', id, '--reason', `Human ${item.kind} left on ${target ?? 'the gate'}`])
      if (r.exitCode !== 0) {
        return { text: `Could not resolve ${id}: ${r.stderr.trim()}` }
      }
    }
    if (target) {
      const problem = await leaveFeedback($, target, item.kind, answer, item.isGate ? undefined : item.label)
      if (problem) {
        return { text: problem }
      }
    }
    void refresh($)

    return {
      text: `Left ${item.kind} on ${target ?? id}.`,
      context: [feedbackContext(target ?? id, item.kind, title, answer)],
    }
  }

  // A labelled ordinary issue is work, not a gate: record the answer on it and
  // take the label off, leaving it open for the agent to carry on.
  if (item && !item.isGate) {
    const c = await bd($, ['comments', 'add', id, `Human answer: ${answer}`])
    if (c.exitCode !== 0) {
      return { text: `Could not comment on ${id}: ${c.stderr.trim()}` }
    }
    if (item.label) {
      await bd($, ['label', 'remove', id, item.label])
    }
    void refresh($)

    return {
      text: `Answered ${id}.`,
      context: [`[bead-inbox] The human answered ${id}${title}: ${answer}. The answer is a comment on ${id}.`],
    }
  }

  const r = await bd($, ['gate', 'resolve', id, '--reason', answer])
  if (r.exitCode !== 0) {
    return { text: `Could not resolve ${id}: ${r.stderr.trim()}` }
  }
  if (item?.blocks) {
    await bd($, ['comments', 'add', item.blocks, `Human answer to ${id} (${item.title}): ${answer}`])
  }
  void refresh($)
  const unblocked = item?.blocks ? ` ${item.blocks} is unblocked.` : ''

  return {
    text: `Resolved ${id}.`,
    context: [`[bead-inbox] The human answered gate ${id}${title}: ${answer}.${unblocked}`],
  }
}

const failed = () => ({ text: 'bead-inbox: the command failed; see the debug log.' })

// Opens the bead in a pane of its own (one per bead), then loads its full
// record, its comments and, for a gate, the bead it blocks.
const openBead = async ($: Engine, beadId: string) => {
  const paneId = paneIdFor(beadId)
  await update($, loading, ids => [...ids.filter(one => one !== paneId), paneId])
  // Draw what the inbox already knows at once; bd fills in the rest.
  const item = (await read($, items)).find(one => one.id === beadId)
  if (item) {
    await update($, views, all => (all[paneId] ? all : { ...all, [paneId]: previewOf(item) }))
  }
  void $.ui.open({ id: paneId, title: beadId })
  const shown = await loadBead($, beadId, item?.blocks)
  await update($, views, all => ({ ...all, [paneId]: shown }))
  await update($, loading, ids => ids.filter(one => one !== paneId))
}

// The bead's full record, its comments and, for a gate, the bead it blocks.
const loadBead = async ($: Engine, beadId: string, blocksId: string | undefined): Promise<BeadView> => {
  // One bd run for the bead, its comments and the bead it blocks: each run
  // costs about a second, more while the poll or an agent holds the database.
  const show = await bd($, ['show', beadId, ...(blocksId ? [blocksId] : []), '--include-comments', '--json'])
  let view: BeadView | undefined
  if (show.exitCode === 0) {
    try {
      view = parseBead(show.stdout, beadId, blocksId)
      // A gate the inbox doesn't list (opened from a link): fetch its target.
      const target = view && !view.blocks && !blocksId ? gateTarget(view.sections[0]?.text) : undefined
      if (target) {
        const both = await bd($, ['show', beadId, target, '--include-comments', '--json'])
        view = both.exitCode === 0 ? (parseBead(both.stdout, beadId, target) ?? view) : view
      }
    } catch {
      view = undefined
    }
  }
  return view ?? {
    id: beadId, title: '', status: '', type: '', priority: null, labels: [], createdAt: '', updatedAt: '',
    sections: [], deps: [], comments: [],
    error: show.exitCode === 0 ? 'could not read bd output' : truncate(show.stderr.trim() || `bd show ${beadId} failed`, 300),
  }
}

// What the list commands reply: bd's error, an empty note, or the items.
const replyWith = async ($: Engine, list: AttnItem[] | undefined, empty: string, details: boolean) => {
  const failure = await read($, error)
  if (failure) {
    return { text: failure }
  }
  if (!list || list.length === 0) {
    return { text: empty }
  }
  const all = await read($, items)

  return {
    text: listText(list, await read($, now), { details, projects: isMixed(all) }),
  }
}

const previewOf = (item: AttnItem): BeadView => ({
  id: item.id,
  title: item.title,
  status: '',
  type: item.isGate ? 'gate' : '',
  priority: null,
  labels: item.label ? [item.label] : [],
  createdAt: item.createdAt,
  updatedAt: '',
  sections: item.details ? [{ heading: 'Details', text: item.details }] : [],
  deps: [],
  comments: [],
  blocks: item.blocks ? { id: item.blocks, title: '', status: '', type: '', description: '' } : undefined,
})

const fillPrompt = ($: Engine, text: string) => $.prompt.fill({ text, mode: 'replace' })

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    sessionFolder = folderName(e.cwd)
    await $.tool.register({
      name: TOOL,
      description:
        'File a question for the human as a beads human gate, shown in their persistent inbox. Use for decisions, approvals, questions only the human can answer, reviews and feedback. Returns at once with the gate id; do not wait for the answer.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: [...KINDS] },
          question: { type: 'string', description: 'The question in one line' },
          details: {
            type: 'string',
            description: 'Context, the options (A/B/C) and your recommendation',
          },
          blocks: {
            type: 'string',
            description: 'The bead id this question holds up, if any; otherwise a follow-up bead is made',
          },
          project: {
            type: 'string',
            description: "The project this concerns, shown as a tag in the inbox. Defaults to the session's folder name; a project already on the `blocks` bead takes precedence",
          },
        },
        required: ['kind', 'question'],
      },
    })
    for (const command of [
      { name: 'inbox', description: 'Show beads that need your attention' },
      { name: 'inbox-list', description: 'List the inbox as text, with details', argumentHint: '[kind|project]' },
      { name: 'inbox-search', description: 'Find inbox items holding every word', argumentHint: '<words>' },
      { name: 'inbox-show', description: 'Show a bead as text: details, comments, what it blocks', argumentHint: '<bead-id>' },
      { name: 'answer', description: 'Answer a human gate', argumentHint: '<gate-id> <answer>' },
      { name: 'approve', description: 'Approve a human gate', argumentHint: '<gate-id> [note]' },
      { name: 'reject', description: 'Reject a human gate', argumentHint: '<gate-id> <reason>' },
      { name: 'inbox-dismiss', description: 'Dismiss an item without an answer', argumentHint: '<id>' },
      { name: 'inbox-help', description: 'How to use the bead-inbox plugin' },
      { name: 'inbox-open', description: 'Open a bead in its own pane', argumentHint: '<bead-id>' },
    ]) {
      await $.command.register({ ...command, immediate: true })
    }
    $.clock.every(POLL_MS, () => void refresh($))
    void refresh($)
    void $.ui.open({ id: PANE, title: 'Needs you' })

    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [...composed.sections, { id: `${PLUGIN}:guidance`, text: GUIDANCE, scope: 'session' }],
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const started = await next({ ...e, prompt: e.prompt + SUBAGENT_GUIDANCE })
    if (!started.deny && started.agentId) {
      askedBy.set(started.agentId, e.description || e.subagentType)
    }

    return started
  })

  on('tool.call', { tool: 'mcp__bead-inbox__ask_human' }, async ($, e) => {
    const input = e as unknown as AskInput & { agentId?: string }
    const question = input.question?.trim()
    if (!question) {
      return { deny: 'ask_human needs a question.' }
    }
    if (input.agentId) {
      filedBy.add(input.agentId)
    }
    const source = input.agentId ? (askedBy.get(input.agentId) ?? 'a subagent') : 'manager'
    const kind = isKind(input.kind) ? input.kind : 'question'
    const blocks = input.blocks?.trim() || undefined
    const project = await projectFor($, blocks, input.project)

    // A retry of a call that filed but failed to answer must not file again.
    await refresh($)
    const existing = (await read($, items)).find(
      one =>
        isRepeat(one, question, project) ||
        (isFeedbackKind(kind) && blocks !== undefined && one.id === blocks && one.kind === kind),
    )
    if (existing) {
      return {
        result: `Already in the human's inbox as ${existing.id}; nothing new was filed. Carry on with other work.`,
      }
    }

    const filed = await fileGate($, kind, question, input.details ?? '', blocks, source, project)
    if ('error' in filed) {
      return { deny: `Could not file the question: ${filed.error}` }
    }
    void refresh($)

    return {
      result: filed.isGate
        ? `Filed human gate ${filed.id} blocking ${filed.blocks}. The human sees it in their inbox. Carry on with other work; the answer will be the gate's close reason and a comment on ${filed.blocks}.`
        : `Asked the human for ${kind} on ${filed.id} (labelled attn:${kind}; nothing is blocked). Carry on. Their notes will arrive as a comment on ${filed.id}, which will then carry the ${FEEDBACK_LABEL} label until you address them.`,
    }
  }).catch(() => ({
    deny: 'ask_human hit an internal error. The question may already be filed: do not retry; tell the human to check /inbox.',
  }))

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if ((e.tool === 'Bash' && /\bbd\b/.test(e.command)) || e.tool === 'Agent') {
      void refresh($)
    }

    return ran
  })

  // Backup for subagents that asked in prose: pull the questions out with a
  // cheap model, outside the main context, and file them as gates.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const agentId = e.agentId
    if (agentId && e.reason === 'answer' && !filedBy.has(agentId) && mightHoldQuestions(e.answer)) {
      void (async () => {
        const r = await $.model.complete({
          model: 'haiku',
          system: EXTRACT_SYSTEM,
          prompt: e.answer.slice(-16_000),
          maxTokens: 2000,
          effort: 'low',
          timeoutMs: 60_000,
        })
        if (!r.isAnswered) {
          return
        }
        const source = `${askedBy.get(agentId) ?? 'a subagent'} (auto-extracted)`
        const project = await projectFor($, undefined, undefined)
        for (const one of parseExtracted(r.text)) {
          await fileGate($, one.kind, one.question, one.details, undefined, source, project)
        }
        void refresh($)
      })()
    }

    return done
  })

  on('command.run', { command: 'inbox-open' }, async ($, e) => {
    const beadId = e.args.trim().split(/\s+/)[0]
    if (!beadId) {
      return { text: 'Usage: /inbox-open <bead-id>' }
    }
    await openBead($, beadId)

    return { text: `Opened ${beadId}.` }
  }).catch(failed)

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const paneId = e.requestId
    if (!paneId.startsWith('bead-') || paneId === HELP_PANE || paneId === PANE) {
      return next(e)
    }
    const { Box, Button, Text } = $.ui.resolve(e)
    const view = (await read($, views))[paneId]
    const isLoading = (await read($, loading)).includes(paneId)
    if (!view) {
      return <Text dimColor>{isLoading ? 'Loading…' : 'Nothing loaded. Use /inbox-open <id>.'}</Text>
    }
    const close = <Button key="close" label="Close" dimColor onPress={() => $.ui.close({ id: paneId })} />
    if (view.error) {
      return (
        <Box flexDirection="column">
          <Text color="warning" wrap="wrap">
            {view.id}: {view.error}
          </Text>
          {close}
        </Box>
      )
    }
    const list = await read($, items)
    const item = list.find(one => one.id === view.id)
    const project = isMixed(list) ? (item?.project ?? projectOf(view.id, view.labels)) : undefined
    const colorOf = projectColors(list.map(one => one.project))
    const meta = [
      view.type,
      view.status,
      view.priority === null ? '' : `P${view.priority}`,
      view.assignee ? `@${view.assignee}` : '',
      view.labels.length > 0 ? view.labels.join(', ') : '',
    ].filter(Boolean)

    return (
      <Box flexDirection="column">
        <Text bold wrap="wrap">
          {project ? (
            <Text color={CHIP_TEXT} backgroundColor={colorOf(project)}>
              {chipText(project)}
            </Text>
          ) : null}
          {project ? ' ' : ''}
          {view.title} <Text dimColor>{view.id}</Text>
        </Text>
        <Text dimColor wrap="wrap">
          {meta.join(' · ')}
          {isLoading ? ' · refreshing…' : ''}
        </Text>
        <Text dimColor>
          created {view.createdAt} · updated {view.updatedAt}
        </Text>
        <Box flexDirection="row" gap={1} marginTop={1}>
          {item?.kind === 'approval' ? (
            <Button key="approve" label="Approve" onPress={() => resolve($, view.id, 'APPROVED')} />
          ) : null}
          {item ? (
            <Button
              key="answer"
              label={item.kind === 'approval' ? 'Reject…' : 'Answer…'}
              onPress={() => fillPrompt($, `/${item.kind === 'approval' ? 'reject' : 'answer'} ${view.id} `)}
            />
          ) : null}
          <Button key="reload" label="Refresh" dimColor onPress={() => openBead($, view.id)} />
          {close}
        </Box>
        {view.sections.map(section => (
          <Box key={section.heading} flexDirection="column" marginTop={1}>
            <Text bold color="claude">
              {section.heading}
            </Text>
            <Text wrap="wrap">{section.text}</Text>
          </Box>
        ))}
        {view.blocks ? (
          <Box key="blocks" flexDirection="column" marginTop={1}>
            <Text bold color="claude">
              Blocks
            </Text>
            <Box flexDirection="row" gap={1}>
              <Button key={`open:${view.blocks.id}`} label={view.blocks.id} plain onPress={() => openBead($, view.blocks?.id ?? '')} />
              <Text wrap="wrap">
                {view.blocks.title} <Text dimColor>({view.blocks.type}, {view.blocks.status})</Text>
              </Text>
            </Box>
            {view.blocks.description ? (
              <Text dimColor wrap="wrap">
                {truncate(view.blocks.description, 1500)}
              </Text>
            ) : null}
          </Box>
        ) : null}
        {view.deps.length > 0 ? (
          <Box key="deps" flexDirection="column" marginTop={1}>
            <Text bold color="claude">
              Depends on ({view.deps.length})
            </Text>
            {view.deps.map(dep => (
              <Box key={`dep:${dep.id}`} flexDirection="row" gap={1}>
                <Button key={`open:${dep.id}`} label={dep.id} plain onPress={() => openBead($, dep.id)} />
                <Text wrap="truncate-end">
                  {dep.title} <Text dimColor>({dep.type}, {dep.status})</Text>
                </Text>
              </Box>
            ))}
          </Box>
        ) : null}
        <Box key="comments" flexDirection="column" marginTop={1}>
          <Text bold color="claude">
            Comments ({view.comments.length})
          </Text>
          {view.comments.map(comment => (
            <Box flexDirection="column" marginBottom={1}>
              <Text dimColor>
                {comment.author} · {comment.createdAt}
              </Text>
              <Text wrap="wrap">{comment.text}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })

  // The commands section as text too: a remote client may not show the pane.
  on('command.run', { command: 'inbox-help' }, async $ => {
    await $.ui.open({ id: HELP_PANE, title: 'Inbox help' }).catch(() => undefined)
    const commands = HELP.find(([heading]) => heading === 'Commands')?.[1] ?? []

    return { text: ['Inbox help opened. Commands:', ...commands].join('\n') }
  }).catch(failed)

  on('ui.render', { component: 'Pane', requestId: HELP_PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box flexDirection="column">
        {HELP.map(([heading, lines]) => (
          <Box key={heading} flexDirection="column" marginBottom={1}>
            <Text bold color="claude">
              {heading}
            </Text>
            {lines.map(line => (
              <Text wrap="wrap">{line}</Text>
            ))}
          </Box>
        ))}
      </Box>
    )
  })

  // Each list command replies in text as well, so it reads the same over
  // Remote Control, where the band and the pane may not show.
  on('command.run', { command: 'inbox' }, async $ => {
    await refresh($)
    // Where nothing draws a pane the reply below still answers.
    await $.ui.open({ id: PANE, title: 'Needs you' }).catch(() => undefined)
    const list = await read($, items)
    const reply = await replyWith($, list, 'Nothing needs you.', false)
    if (list.length === 0) {
      return reply
    }

    return { text: `${list.length} item${list.length === 1 ? ' needs' : 's need'} you:\n\n${reply.text}` }
  }).catch(failed)

  on('command.run', { command: 'inbox-list' }, async ($, e) => {
    await refresh($)
    const list = await read($, items)
    const filter = e.args.trim()
    const narrowed = filterItems(list, filter)
    if (!narrowed && list.length > 0) {
      const projects = [...new Set(list.map(one => one.project))].join(', ')

      return { text: `"${filter}" is neither a kind (${KINDS.map(kind => TAG[kind]).join(', ')}) nor a project in the inbox (${projects}).` }
    }

    return replyWith($, narrowed, filter ? `Nothing in the inbox for "${filter}".` : 'Nothing needs you.', true)
  }).catch(failed)

  on('command.run', { command: 'inbox-search' }, async ($, e) => {
    const query = e.args.trim()
    if (!query) {
      return { text: 'Usage: /inbox-search <words>' }
    }
    await refresh($)

    return replyWith($, searchItems(await read($, items), query), `No inbox item matches "${query}".`, true)
  }).catch(failed)

  on('command.run', { command: 'inbox-show' }, async ($, e) => {
    const beadId = e.args.trim().split(/\s+/)[0]
    if (!beadId) {
      return { text: 'Usage: /inbox-show <bead-id>' }
    }
    const item = (await read($, items)).find(one => one.id === beadId)
    const view = await loadBead($, beadId, item?.blocks)
    const how = item?.kind === 'approval' ? `/approve ${beadId} [note] or /reject ${beadId} <reason>` : `/answer ${beadId} <text>`

    return { text: item && !view.error ? `${beadText(view)}\n\nReply: ${how}` : beadText(view) }
  }).catch(failed)

  on('command.run', { command: 'inbox-dismiss' }, async ($, e) => {
    const beadId = e.args.trim().split(/\s+/)[0]
    if (!beadId) {
      return { text: 'Usage: /inbox-dismiss <id>' }
    }

    return resolve($, beadId, DISMISSED)
  }).catch(failed)

  on('command.run', { command: 'answer' }, async ($, e) => {
    const parsed = splitIdAndText(e.args)
    if (!parsed?.text) {
      return { text: 'Usage: /answer <gate-id> <answer>' }
    }

    return resolve($, parsed.id, parsed.text)
  }).catch(failed)

  on('command.run', { command: 'approve' }, async ($, e) => {
    const parsed = splitIdAndText(e.args)
    if (!parsed) {
      return { text: 'Usage: /approve <gate-id> [note]' }
    }

    return resolve($, parsed.id, parsed.text ? `APPROVED. ${parsed.text}` : 'APPROVED')
  }).catch(failed)

  on('command.run', { command: 'reject' }, async ($, e) => {
    const parsed = splitIdAndText(e.args)
    if (!parsed?.text) {
      return { text: 'Usage: /reject <gate-id> <reason>' }
    }

    return resolve($, parsed.id, `REJECTED: ${parsed.text}`)
  }).catch(failed)

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, items)
    if (e.props.hasSurvey || list.length === 0) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const at = await read($, now)
    const more = list.length - BAND_ROWS
    const mixed = isMixed(list)
    const colorOf = projectColors(list.map(one => one.project))

    return (
      <Box flexDirection="column">
        {list.slice(0, BAND_ROWS).map(item => (
          <Text wrap="truncate-end">
            <Text color={COLOR[item.kind]}>⚑ [{TAG[item.kind]}]</Text>{' '}
            {mixed ? (
              <Text color={CHIP_TEXT} backgroundColor={colorOf(item.project)}>
                {chipText(item.project)}
              </Text>
            ) : null}
            {mixed ? ' ' : ''}
            {item.title}{' '}
            <Text dimColor>
              {item.id} · {age(item.createdAt, at)}
            </Text>
          </Text>
        ))}
        <Text dimColor>
          {more > 0 ? `+${more} more · ` : ''}/inbox for details · /answer {'<id> <text>'}
        </Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, items)
    const failed = await read($, error)
    const at = await read($, now)
    const room = Math.max(4, (e.viewport?.rows ?? 30) - 2)

    if (failed) {
      return <Text color="warning" wrap="wrap">{failed}</Text>
    }
    if (list.length === 0) {
      return <Text dimColor>Nothing needs you. Gates filed by agents show here.</Text>
    }

    const mixed = isMixed(list)
    const colorOf = projectColors(list.map(one => one.project))
    const rows: RenderChildren[] = []
    let used = 0
    for (const kind of KINDS) {
      const group = list.filter(one => one.kind === kind)
      if (group.length === 0 || used >= room) {
        continue
      }
      rows.push(
        <Text bold color={COLOR[kind]}>
          {TAG[kind].toUpperCase()} ({group.length})
        </Text>,
      )
      used += 1
      for (const item of group) {
        if (used >= room) {
          break
        }
        rows.push(
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            <Text wrap="wrap">
              {mixed ? (
                <Text color={CHIP_TEXT} backgroundColor={colorOf(item.project)}>
                  {chipText(item.project)}
                </Text>
              ) : null}
              {mixed ? ' ' : ''}
              <Text bold>{item.title}</Text>{' '}
              <Text dimColor>
                {item.id}
                {item.blocks ? ` → ${item.blocks}` : ''} · {age(item.createdAt, at)}
              </Text>
            </Text>
            {item.details ? (
              <Text dimColor wrap="wrap">
                {truncate(item.details, 600)}
              </Text>
            ) : null}
            <Box flexDirection="row" gap={1}>
              <Button key={`${item.id}:open`} label="Open" onPress={() => openBead($, item.id)} />
              {item.kind === 'approval' ? (
                <Button key={`${item.id}:approve`} label="Approve" onPress={() => resolve($, item.id, 'APPROVED')} />
              ) : null}
              {item.kind === 'approval' ? (
                <Button key={`${item.id}:reject`} label="Reject…" onPress={() => fillPrompt($, `/reject ${item.id} `)} />
              ) : (
                <Button key={`${item.id}:answer`} label="Answer…" onPress={() => fillPrompt($, `/answer ${item.id} `)} />
              )}
              <Button
                key={`${item.id}:dismiss`}
                label="Dismiss"
                dimColor
                onPress={() => resolve($, item.id, DISMISSED)}
              />
            </Box>
          </Box>,
        )
        used += item.details ? 4 : 3
      }
    }

    return <Box flexDirection="column">{rows}</Box>
  })
}
