import { atom, read, update } from 'claude-code'
import type { CommandRunResult, EngineInterface, PluginOptions, Register, RenderChildren } from 'claude-code'

import type { AttnItem, AttnKind, BeadView } from '../types'
import {
  CHIP_TEXT,
  COLOR,
  DOLT_JOURNAL,
  HELP,
  KINDS,
  TAG,
  TIMED_OUT,
  age,
  applyFilter,
  beadText,
  chipText,
  filterItems,
  filterText,
  isFiltered,
  jsonFrom,
  listText,
  matchId,
  parseInboxArgs,
  parseSnapshot,
  recentDuplicate,
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
  shouldRetry,
  splitCommandLine,
  splitIdAndText,
  splitLinks,
  statusText,
  storeSignature,
  truncate,
  createdId,
  gateTarget,
  quickId,
  paneIdFor,
  parseBead,
} from './lib'
import type { InboxFilter, RawComment, RunResult, StorePart } from './lib'

const PLUGIN = 'bead-inbox'
const PANE = 'bead-inbox'
const HELP_PANE = 'bead-inbox-help'
const TOOL = 'ask_human'
const TOOL_ID = 'mcp__bead-inbox__ask_human'
const FEEDBACK_LABEL = 'human-feedback'
const BAND_ROWS = 3
const DISMISSED = 'Dismissed by the human without an answer; use your judgment.'
const BD_TIMEOUT_MS = 120_000
const SNAPSHOT_TIMEOUT_MS = 120_000
const ON_ANSWERED_TIMEOUT_MS = 30_000
// Poll intervals when the poll-interval setting is 0.
const POLL_DIRECT_MS = 60_000
const POLL_SNAPSHOT_MS = 15_000
const POLL_SIGNATURE_MS = 10_000
// With an unchanged store signature, read bd anyway once the list is this old.
const MAX_AGE_MS = 60_000
const EXTRACTOR_MODELS = ['haiku', 'sonnet', 'opus'] as const

const items = atom({ plugin: 'bead-inbox', key: 'items' } as const, [])
const error = atom({ plugin: 'bead-inbox', key: 'error' } as const, null)
const now = atom({ plugin: 'bead-inbox', key: 'now' } as const, 0)
const views = atom({ plugin: 'bead-inbox', key: 'views' } as const, {})
const loading = atom({ plugin: 'bead-inbox', key: 'loading' } as const, [])
const filter = atom({ plugin: 'bead-inbox', key: 'filter' } as const, {})
const notSaved = atom({ plugin: 'bead-inbox', key: 'notSaved' } as const, {})

const GUIDANCE = `Human attention inbox (bead-inbox plugin): whenever you need a decision, approval, answer, review or feedback from the human, call the ${TOOL_ID} tool instead of only writing the question in prose. Prose questions scroll out of sight during long autonomous runs; the tool puts them in a persistent inbox the human sees. Call it once per distinct question and never retry a call that returned a result. Pass \`blocks\` with the bead the question concerns when there is one, and \`project\` when the work belongs to a project other than the session's folder. Decisions, approvals and questions become a beads human gate blocking that bead: do not wait, carry on with other ready work; the answer arrives as the gate's close reason and as a comment on the blocked bead. Review and feedback block nothing: they label the bead attn:review or attn:feedback. When the human responds, their notes are a comment on the bead and it carries the ${FEEDBACK_LABEL} label (reopened if it was closed): address the notes, then remove that label (\`bd label remove <id> ${FEEDBACK_LABEL}\`). Check \`bd list --label ${FEEDBACK_LABEL}\` for feedback still to address. When relaying a subagent's questions, file each one with the tool unless the subagent already did.`

const SUBAGENT_GUIDANCE = `

---
If you need a decision, approval, answer, review or feedback from the human, call the ${TOOL_ID} tool (one call per question, never retried, with your options and recommendation in \`details\`, and \`blocks\` set to the bead your task is on if you know it), then finish whatever work does not depend on the answer. A bead labelled ${FEEDBACK_LABEL} has human notes in its comments: address them, then remove that label.`

const EXTRACT_SYSTEM = `You read a report a coding subagent handed back to its manager and list every point where it needs a HUMAN to act: a decision, an approval, a question only the human can answer, a review, or feedback. Ignore rhetorical questions, questions the report answers itself, and routine next steps the manager can decide alone. Reply with a JSON array only, no prose: [{"kind":"decision|approval|question|review|feedback","question":"one line","details":"the context, options and any recommendation, in the report's words"}]. Reply [] when there is nothing.`

type Engine = EngineInterface
type AskInput = { kind?: string; question?: string; details?: string; blocks?: string; project?: string }

type Settings = {
  extractorModel: (typeof EXTRACTOR_MODELS)[number]
  autoExtract: boolean
  pollMs: number | undefined
  storeSignature: boolean
  snapshot: string[]
  snapshotForce: string[]
  onAnswered: string[]
}

const readSettings = (options: PluginOptions | undefined): Settings => {
  const text = (key: string) => (typeof options?.[key] === 'string' ? (options[key] as string) : '')
  const model = text('extractorModel')
  const poll = options?.pollSeconds

  return {
    extractorModel: (EXTRACTOR_MODELS as readonly string[]).includes(model)
      ? (model as Settings['extractorModel'])
      : 'sonnet',
    autoExtract: options?.autoExtract !== false,
    pollMs: typeof poll === 'number' && poll > 0 ? poll * 1000 : undefined,
    storeSignature: options?.storeSignature !== false,
    snapshot: splitCommandLine(text('snapshotCommand')),
    snapshotForce: splitCommandLine(text('snapshotForceArgs')),
    onAnswered: splitCommandLine(text('onAnsweredCommand')),
  }
}

let settings = readSettings(undefined)
let bdArgv: string[] | null = null
let seen: Set<string> | null = null
let sessionFolder: string | undefined
let isInteractive = false
const askedBy = new Map<string, string>()
const filedBy = new Set<string>()

// Answers in flight or just made, by item id: `pending` while the writes run,
// then the time they finished. A refresh drops the item until one whose bd
// reads began after that time, so a poll that read before the answer cannot
// bring it back.
// The item and its place are kept, so answering it again (a quick retry)
// takes the same path, and a failed write puts it back where it was.
const hidden = new Map<string, { pending: boolean; at: number; item: AttnItem; position: number }>()
// A comment that saved while the label removal after it failed, by bead: the
// same answer again only retries the label.
const labelStuck = new Map<string, string>()

const errorText = (err: unknown): string =>
  err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown error'

const cut = (stderr: string): string => truncate(stderr.trim() || 'no error text', 120)

// The engine's clock (a test's mock clock), else the wall clock.
const clockNow = async ($: Engine): Promise<number> => {
  try {
    return await $.clock.now()
  } catch {
    return Date.now()
  }
}

// The Bash tool finds bd through a shell; a shell-less run cannot start an
// npm .cmd shim, and through cmd.exe an argument ends at its first newline,
// so the real binary comes first.
const findBd = async ($: Engine): Promise<string[] | null> => {
  const tryRun = async (argv: string[]) => {
    try {
      const r = await $.process.run([...argv, 'version'], { timeoutMs: 10_000 })
      return r.exitCode === 0
    } catch {
      return false
    }
  }
  if (await tryRun(['bd.exe'])) {
    return ['bd.exe']
  }
  try {
    const where = await $.process.run(['where.exe', 'bd'], { timeoutMs: 10_000 })
    for (const line of where.stdout.split(/\r?\n/).map(one => one.trim()).filter(Boolean)) {
      const dir = line.replace(/[\\/][^\\/]+$/, '')
      for (const exe of [
        line.endsWith('.exe') ? line : `${line.replace(/\.(cmd|bat|ps1)$/i, '')}.exe`,
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
  if (await tryRun(['bd'])) {
    return ['bd']
  }

  return null
}

const runOnce = async ($: Engine, argv: string[], stdin: string | undefined, timeoutMs: number, what: string): Promise<RunResult> => {
  try {
    const r = await $.process.run(argv, stdin === undefined ? { timeoutMs } : { timeoutMs, stdin })

    return { exitCode: r.exitCode, stdout: r.stdout, stderr: r.stderr }
  } catch (err) {
    return { exitCode: TIMED_OUT, stdout: '', stderr: `${what} timed out or could not start: ${errorText(err)}` }
  }
}

// Never throws: a timeout or a failed start reads as exit 124. One retry on a
// lock error, or on a timeout of a command that creates nothing.
const bd = async ($: Engine, args: string[], stdin?: string): Promise<RunResult> => {
  bdArgv ??= await findBd($)
  if (bdArgv === null) {
    return { exitCode: 127, stdout: '', stderr: 'bd not found on PATH' }
  }
  const first = await runOnce($, [...bdArgv, ...args], stdin, BD_TIMEOUT_MS, 'bd')

  return shouldRetry(args, first) ? runOnce($, [...bdArgv, ...args], stdin, BD_TIMEOUT_MS, 'bd') : first
}

// ---- the beads store signature ----

let beadsDir: string | null | undefined

const parentOf = (path: string): string | undefined => {
  const trimmed = path.replace(/[\\/]+$/, '')
  const cutAt = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'))

  return cutAt <= 0 || /^[A-Za-z]:$/.test(trimmed) ? undefined : trimmed.slice(0, cutAt)
}

// Where bd finds the database: BEADS_DIR, else the nearest .beads above the
// session's folder.
const findBeadsDir = async ($: Engine): Promise<string | null> => {
  const set = await $.env.get('BEADS_DIR').catch(() => undefined)
  if (set) {
    return set
  }
  let dir: string | undefined = await $.session.cwd()
  while (dir) {
    const candidate = `${dir}/.beads`
    if (await $.fs.exists(candidate).catch(() => false)) {
      return candidate
    }
    dir = parentOf(dir)
  }

  return null
}

// File metadata and one small read per database, no bd process: Dolt's
// journal grows on every write and the manifest changes on every commit,
// while reads touch neither (modification times are not usable: reads touch
// them). Undefined for a store it does not recognise.
const readSignature = async ($: Engine): Promise<string | undefined> => {
  if (!settings.storeSignature || settings.snapshot.length > 0) {
    return undefined
  }
  try {
    beadsDir ??= await findBeadsDir($)
    if (!beadsDir) {
      return undefined
    }
    const parts: StorePart[] = []
    for (const backend of ['embeddeddolt', 'dolt']) {
      const root = `${beadsDir}/${backend}`
      const entries = await $.fs.list(root).catch(() => [])
      for (const entry of entries) {
        if (entry.kind !== 'dir') {
          continue
        }
        const noms = `${root}/${entry.name}/.dolt/noms`
        const manifest = await $.fs.read(`${noms}/manifest`).catch(() => undefined)
        if (typeof manifest !== 'string') {
          continue
        }
        const journal = await $.fs.stat(`${noms}/${DOLT_JOURNAL}`).catch(() => undefined)
        parts.push({ database: `${backend}/${entry.name}`, journalSize: journal?.size ?? -1, manifest })
      }
    }

    return storeSignature(parts)
  } catch {
    return undefined
  }
}

// ---- refresh ----

type Reads = { gates: string; attn: string; started: number } | { error: string; isNoDb?: boolean }

const readDirect = async ($: Engine): Promise<Reads> => {
  const started = await clockNow($)
  const gates = await bd($, ['list', '--type', 'gate', '--status', 'open', '--json', '--limit', '0'])
  const labelled = await bd($, [
    'list', '--status', 'open,in_progress,blocked,closed', '--label-pattern', 'attn:*', '--json', '--limit', '0',
  ])
  const broken = [gates, labelled].find(r => r.exitCode !== 0)
  if (broken) {
    const isNoDb = /no beads database/i.test(broken.stderr)

    return {
      isNoDb,
      error: isNoDb
        ? `No beads database found from ${await $.session.cwd()}. Start Claude Code in the project repo (or set BEADS_DIR).`
        : `bd failed: ${truncate(broken.stderr.trim(), 300)}`,
    }
  }

  return { gates: gates.stdout, attn: labelled.stdout, started }
}

const readSnapshot = async ($: Engine, force: boolean): Promise<Reads> => {
  const argv = [...settings.snapshot, ...(force ? settings.snapshotForce : [])]
  const r = await runOnce($, argv, undefined, SNAPSHOT_TIMEOUT_MS, 'snapshot command')
  if (r.exitCode !== 0) {
    return { error: truncate(r.stderr.trim() || `snapshot command exited ${r.exitCode}`, 300) }
  }

  return parseSnapshot(r.stdout)
}

let lastSignature: string | undefined
let lastRefreshAt = Number.NEGATIVE_INFINITY

const doRefresh = async ($: Engine, force: boolean, known?: string): Promise<void> => {
  const started = await clockNow($)
  // Taken before the reads, so a write landing during them shows next poll.
  const signature = known ?? (await readSignature($))
  const reads = settings.snapshot.length > 0 ? await readSnapshot($, force) : await readDirect($)
  await update($, now, () => started)
  if ('error' in reads) {
    await update($, items, () => [])
    await update($, error, () => reads.error)
    $.ui.status(reads.isNoDb ? undefined : '⚑ inbox: bd failed (see /inbox)')

    return
  }
  let all: AttnItem[]
  try {
    all = parseGates(reads.gates, reads.attn)
  } catch {
    await update($, error, () => 'could not parse bd output')

    return
  }
  lastSignature = signature
  lastRefreshAt = started

  // An answer in flight stays hidden whatever these reads saw; a finished one
  // until reads that began after it. Then bd is trusted again.
  for (const [id, record] of hidden) {
    if (!record.pending && reads.started > record.at) {
      hidden.delete(id)
    }
  }
  const list = all.filter(one => !hidden.has(one.id))
  const present = new Set(all.map(one => one.id))
  await update($, notSaved, reasons =>
    Object.fromEntries(Object.entries(reasons).filter(([id]) => present.has(id) && !hidden.has(id))),
  )
  await update($, items, () => list)
  await update($, error, () => null)
  $.ui.status(statusText(list))

  const fresh = seen === null ? [] : list.filter(one => !seen?.has(one.id))
  seen = new Set([...(seen ?? []), ...list.map(one => one.id)].filter(id => present.has(id)))
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

let running: Promise<void> | null = null
let queued: Promise<void> | null = null

// One refresh at a time: a request while one runs shares it. A forced one
// (after our own write) must not, since the running one may have read before
// the write: it runs once more after it, however many ask.
const refresh = ($: Engine, options: { force?: boolean; signature?: string } = {}): Promise<void> => {
  if (!running) {
    running = doRefresh($, options.force === true, options.signature)
      .catch(async (err: unknown) => {
        await update($, error, () => `refresh failed: ${errorText(err)}`)
      })
      .catch(() => undefined)
      .finally(() => {
        running = null
      })

    return running
  }
  if (!options.force) {
    return running
  }
  queued ??= running.then(() => {
    queued = null

    return refresh($, { force: true })
  })

  return queued
}

// Background refreshes (after writes, bd commands, subagents) belong to a
// session with a person at it; others read bd only when asked.
const refreshSoon = ($: Engine, force = false) => {
  if (isInteractive) {
    void refresh($, { force })
  }
}

// The timer's tick: with a store signature, read bd only when it changed or
// the list has grown old; without one, every tick (or each minute when the
// tick is the signature's short one).
const poll = async ($: Engine) => {
  if (settings.snapshot.length > 0 || !settings.storeSignature) {
    return refresh($)
  }
  const signature = await readSignature($)
  const isOld = (await clockNow($)) - lastRefreshAt >= MAX_AGE_MS
  if (signature === undefined) {
    return settings.pollMs !== undefined || isOld ? refresh($) : undefined
  }
  if (signature !== lastSignature || isOld) {
    return refresh($, { signature })
  }

  return undefined
}

const pollInterval = (): number =>
  settings.pollMs ??
  (settings.snapshot.length > 0 ? POLL_SNAPSHOT_MS : settings.storeSignature ? POLL_SIGNATURE_MS : POLL_DIRECT_MS)

const showStatus = async ($: Engine) => {
  if (!(await read($, error))) {
    $.ui.status(statusText(await read($, items)))
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
    const c = await bd(
      $,
      ['comments', 'add', target, '-f', '-'],
      `Human ${kind} requested: ${question}${reason ? `\n\n${reason}` : ''}`,
    )
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

// ---- answering ----

type Saved = { isSaved: true; note: string } | { isSaved: false; stderr: string }

const savedNote = (createdAt: string | undefined, at: number) =>
  createdAt === undefined
    ? ' (this answer was already saved, so it wasn\'t added again)'
    : ` (this answer was already saved ${age(createdAt, at)} ago, so it wasn't added again)`

// Every human comment goes through here: the text on stdin (cmd.exe would cut
// an argument at its first newline), never twice for one answer.
const addComment = async ($: Engine, beadId: string, text: string): Promise<Saved> => {
  if (labelStuck.get(beadId) === text.trim()) {
    return { isSaved: true, note: savedNote(undefined, 0) }
  }
  const alreadySaved = async () => {
    const list = await bd($, ['comments', beadId, '--json'])
    if (list.exitCode !== 0) {
      return undefined
    }
    try {
      const parsed = jsonFrom(list.stdout, [])

      return Array.isArray(parsed) ? recentDuplicate(parsed as RawComment[], text, Date.now()) : undefined
    } catch {
      return undefined
    }
  }
  let last: RunResult | undefined
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const earlier = await alreadySaved()
    if (earlier !== undefined) {
      return { isSaved: true, note: savedNote(earlier, Date.now()) }
    }
    last = await bd($, ['comments', 'add', beadId, '-f', '-'], text)
    if (last.exitCode === 0) {
      return { isSaved: true, note: '' }
    }
    // A timed-out add may have landed: look again before a second one.
    if (last.exitCode !== TIMED_OUT) {
      break
    }
  }

  return { isSaved: false, stderr: last?.stderr ?? '' }
}

// Removes the attn label after the comment saved; remembers a failure so the
// same answer again retries only the label.
const removeLabel = async ($: Engine, beadId: string, label: string, comment: string) => {
  const r = await bd($, ['label', 'remove', beadId, label])
  if (r.exitCode === 0) {
    labelStuck.delete(beadId)

    return undefined
  }
  labelStuck.set(beadId, comment.trim())

  return `couldn't remove ${label}, so it stays in the inbox and answering again will retry (${cut(r.stderr)})`
}

// What one answer's writes came to. `stays`: the item goes back in the inbox.
// `recorded`: the answer is saved somewhere, partial or not.
type Outcome = { text: string; context?: string[]; stays: boolean; recorded: boolean }

const withProblems = (text: string, problems: string[]) =>
  problems.length === 0 ? `${text}.` : `${text}; but ${problems.join('; ')}.`

// Leaves the human's review or feedback on the work bead for the agent to
// address: a comment, the human-feedback label in place of the attn: one, and
// the bead reopened when it was closed so it shows in bd ready again.
const leaveFeedback = async (
  $: Engine,
  beadId: string,
  kind: AttnKind,
  notes: string,
  attnLabel: string | undefined,
): Promise<{ saved: Saved; problems: string[]; isLabelStuck: boolean }> => {
  const comment = `Human ${kind}: ${notes}`
  const saved = await addComment($, beadId, comment)
  if (!saved.isSaved) {
    return { saved, problems: [], isLabelStuck: false }
  }
  const problems: string[] = []
  const stuck = attnLabel ? await removeLabel($, beadId, attnLabel, comment) : undefined
  if (stuck) {
    problems.push(stuck)
  }
  const added = await bd($, ['label', 'add', beadId, FEEDBACK_LABEL])
  if (added.exitCode !== 0) {
    problems.push(`couldn't add ${FEEDBACK_LABEL} (${cut(added.stderr)})`)
  }
  const show = await bd($, ['show', beadId, '--json'])
  if (show.exitCode === 0 && /"status":\s*"closed"/.test(show.stdout)) {
    const reopened = await bd($, ['reopen', beadId])
    if (reopened.exitCode !== 0) {
      problems.push(`couldn't reopen ${beadId} (${cut(reopened.stderr)})`)
    }
  }

  return { saved, problems, isLabelStuck: stuck !== undefined }
}

const feedbackContext = (beadId: string, kind: AttnKind, title: string, notes: string) =>
  `[bead-inbox] The human left ${kind} on ${beadId}${title}: ${notes}. It is a comment on ${beadId}, which is labelled ${FEEDBACK_LABEL} (and reopened if it was closed). Address it, then remove the ${FEEDBACK_LABEL} label.`

const writeAnswer = async ($: Engine, id: string, item: AttnItem | undefined, answer: string): Promise<Outcome> => {
  const title = item ? ` ("${truncate(item.title, 80)}")` : ''

  if (item && isFeedbackKind(item.kind)) {
    // An older review/feedback gate still has to close to unblock its bead;
    // the notes go on that bead either way.
    const target = item.isGate ? item.blocks : item.id
    if (item.isGate) {
      const r = await bd($, ['gate', 'resolve', id, '--reason', `Human ${item.kind} left on ${target ?? 'the gate'}`])
      if (r.exitCode !== 0) {
        return { text: `Could not resolve ${id}: ${r.stderr.trim()}`, stays: true, recorded: false }
      }
    }
    if (!target) {
      return { text: `Resolved ${id}.`, stays: false, recorded: true }
    }
    const left = await leaveFeedback($, target, item.kind, answer, item.isGate ? undefined : item.label)
    if (!left.saved.isSaved) {
      return item.isGate
        ? { text: `Resolved ${id}; but couldn't comment on ${target} (${cut(left.saved.stderr)}).`, stays: false, recorded: true }
        : { text: `Could not comment on ${target}: ${left.saved.stderr.trim()}`, stays: true, recorded: false }
    }

    return {
      text: withProblems(`Left ${item.kind} on ${target}${left.saved.note}`, left.problems),
      context: [feedbackContext(target, item.kind, title, answer)],
      stays: left.isLabelStuck,
      recorded: true,
    }
  }

  // A labelled ordinary issue is work, not a gate: record the answer on it and
  // take the label off, leaving it open for the agent to carry on.
  if (item && !item.isGate) {
    const comment = `Human answer: ${answer}`
    const saved = await addComment($, id, comment)
    if (!saved.isSaved) {
      return { text: `Could not comment on ${id}: ${saved.stderr.trim()}`, stays: true, recorded: false }
    }
    const stuck = item.label ? await removeLabel($, id, item.label, comment) : undefined

    return {
      text: withProblems(`Answered ${id}${saved.note}`, stuck ? [stuck] : []),
      context: [`[bead-inbox] The human answered ${id}${title}: ${answer}. The answer is a comment on ${id}.`],
      stays: stuck !== undefined,
      recorded: true,
    }
  }

  // The close reason stays an argument: bd reads it from no file.
  const r = await bd($, ['gate', 'resolve', id, '--reason', answer])
  if (r.exitCode !== 0) {
    return { text: `Could not resolve ${id}: ${r.stderr.trim()}`, stays: true, recorded: false }
  }
  const problems: string[] = []
  let note = ''
  if (item?.blocks) {
    const saved = await addComment($, item.blocks, `Human answer to ${id} (${item.title}): ${answer}`)
    if (saved.isSaved) {
      note = saved.note
    } else {
      problems.push(`couldn't comment on ${item.blocks} (${cut(saved.stderr)})`)
    }
  }
  const unblocked = item?.blocks ? ` ${item.blocks} is unblocked.` : ''

  return {
    text: withProblems(`Resolved ${id}${note}`, problems),
    context: [`[bead-inbox] The human answered gate ${id}${title}: ${answer}.${unblocked}`],
    stays: false,
    recorded: true,
  }
}

// Tells an outside dispatcher at once; never awaited, its failures ignored.
// What was answered goes as named arguments, the command's whole input.
const runOnAnswered = ($: Engine, id: string, blocks: string | undefined) => {
  if (settings.onAnswered.length === 0) {
    return
  }
  const argv = [...settings.onAnswered, '--id', id, ...(blocks ? ['--blocks', blocks] : [])]
  void $.process.run(argv, { timeoutMs: ON_ANSWERED_TIMEOUT_MS }).catch(() => undefined)
}

// The item leaves the inbox before the first bd write (which can wait minutes
// on the database lock); if the writes fail it comes back where it was, with
// the reason.
const resolve = async ($: Engine, id: string, answer: string): Promise<CommandRunResult> => {
  const list = await read($, items)
  const index = list.findIndex(one => one.id === id)
  const earlier = hidden.get(id)
  const item = list[index] ?? earlier?.item
  const position = index >= 0 ? index : (earlier?.position ?? list.length)
  if (item) {
    hidden.set(id, { pending: true, at: 0, item, position })
    await update($, notSaved, reasons => Object.fromEntries(Object.entries(reasons).filter(([one]) => one !== id)))
    await update($, items, all => all.filter(one => one.id !== id))
    await showStatus($)
  }
  let outcome: Outcome
  try {
    outcome = await writeAnswer($, id, item, answer)
  } catch (err) {
    outcome = { text: `Could not answer ${id}: ${errorText(err)}`, stays: true, recorded: false }
  }
  if (item) {
    if (outcome.stays) {
      hidden.delete(id)
      await update($, items, all =>
        all.some(one => one.id === id) ? all : [...all.slice(0, position), item, ...all.slice(position)],
      )
      await update($, notSaved, reasons => ({ ...reasons, [id]: outcome.text }))
    } else {
      hidden.set(id, { pending: false, at: await clockNow($), item, position })
    }
    await showStatus($)
  }
  if (outcome.recorded) {
    refreshSoon($, true)
    runOnAnswered($, id, item?.blocks)
  }

  return outcome.recorded && outcome.context ? { text: outcome.text, context: outcome.context } : { text: outcome.text }
}

// A pane button: say so at once, then the result, without holding the press.
const pressAnswer = ($: Engine, id: string, answer: string) => {
  $.ui.toast(`${id}: saving…`, { timeoutMs: 4000 })
  void resolve($, id, answer).then(
    r => $.ui.toast(r.text ?? `${id}: done`, { timeoutMs: 10_000 }),
    (err: unknown) => $.ui.toast(`${id}: failed: ${errorText(err)}`, { timeoutMs: 15_000 }),
  )
}

// Names the command and the cause, never a bare "see the debug log".
const failed = (_$: unknown, e: { command?: string }, next: { error?: { kind?: string; message?: string } }) => ({
  text: `bead-inbox: /${e.command ?? 'command'} failed: ${next.error?.message || next.error?.kind || 'unknown error'}`,
})

// The host may leave `args` out (a bare /inbox).
const argsOf = (e: { args?: string }): string => (e.args ?? '').trim()

// Runs `act` on the full id of what the person typed ("u1y" for "ait-u1y").
// Just after a reload the list is empty until the next poll, so a miss
// refreshes it once before the id goes to bd as typed.
const withId = async ($: Engine, typed: string, act: (id: string) => Promise<CommandRunResult>) => {
  const inList = (id: string) => read($, items).then(list => list.some(one => one.id === id))
  let match = matchId(await read($, items), typed)
  if ('id' in match && !(await inList(match.id)) && !hidden.has(match.id)) {
    await refresh($)
    match = matchId(await read($, items), typed)
  }
  if ('ambiguous' in match) {
    return { text: `"${typed}" could be ${match.ambiguous.join(' or ')}: give the full id.` }
  }

  return act(match.id)
}

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
  void $.ui.open({ id: paneId, title: beadId }).catch(() => undefined)
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

// Sets the pane's filter and brings its top (the filter bar) into view.
const setFilter = async ($: Engine, next: InboxFilter) => {
  await update($, filter, () => next)
  await $.ui.scroll({ to: 'start', in: PANE }).catch(() => undefined)
}

export const register: Register = (on, options) => {
  settings = readSettings(options)

  on('session.start', async ($, e, next) => {
    sessionFolder = folderName(e.cwd)
    isInteractive = e.isInteractive === true
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
      { name: 'inbox', description: 'Show beads that need your attention', argumentHint: '[kind] [project:<name>]' },
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
    // Only a session with a person at it keeps the band and the pane fresh:
    // background and -p sessions would only add to the lock contention.
    if (isInteractive) {
      $.clock.every(pollInterval(), () => void poll($))
      void refresh($)
      void $.ui.open({ id: PANE, title: 'Needs you' }).catch(() => undefined)
    }

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
    refreshSoon($, true)

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
      refreshSoon($)
    }

    return ran
  })

  // Backup for subagents that asked in prose: pull the questions out with a
  // model, outside the main context, and file them as gates. Off when the
  // agents file their own.
  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const agentId = e.agentId
    if (
      settings.autoExtract &&
      agentId &&
      e.reason === 'answer' &&
      !filedBy.has(agentId) &&
      mightHoldQuestions(e.answer)
    ) {
      void (async () => {
        const r = await $.model.complete({
          model: settings.extractorModel,
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
        refreshSoon($, true)
      })().catch(() => undefined)
    }

    return done
  })

  on('command.run', { command: 'inbox-open' }, async ($, e) => {
    const beadId = argsOf(e).split(/\s+/)[0]
    if (!beadId) {
      return { text: 'Usage: /inbox-open <bead-id>' }
    }

    return withId($, beadId, async id => {
      await openBead($, id)

      return { text: `Opened ${id}.` }
    })
  }).catch(failed)

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const paneId = e.requestId
    if (!paneId.startsWith('bead-') || paneId === HELP_PANE || paneId === PANE) {
      return next(e)
    }
    const { Box, Button, Link, Text } = $.ui.resolve(e)
    // Inline markdown links drawn as links; the rest stays plain, in order.
    const linked = (text: string) =>
      splitLinks(text).map(run => (run.href ? <Link href={run.href}>{run.text}</Link> : run.text))
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
    const reason = (await read($, notSaved))[view.id]
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
        {reason ? (
          <Text color="warning" wrap="wrap">
            Not saved: {reason}
          </Text>
        ) : null}
        <Box flexDirection="row" gap={1} marginTop={1}>
          {item?.kind === 'approval' ? (
            <Button key="approve" label="Approve" onPress={() => pressAnswer($, view.id, 'APPROVED')} />
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
            <Text wrap="wrap">{linked(section.text)}</Text>
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
                {linked(truncate(view.blocks.description, 1500))}
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
              <Text wrap="wrap">{linked(comment.text)}</Text>
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
  on('command.run', { command: 'inbox' }, async ($, e) => {
    await setFilter($, parseInboxArgs(argsOf(e)))
    await refresh($)
    // Where nothing draws a pane the reply below still answers.
    await $.ui.open({ id: PANE, title: 'Needs you' }).catch(() => undefined)
    const list = await read($, items)
    const chosen = await read($, filter)
    const shown = isFiltered(chosen) ? applyFilter(list, chosen) : list
    const reply = await replyWith($, shown, list.length === 0 ? 'Nothing needs you.' : 'Nothing matches the filter.', false)
    if (shown.length === 0) {
      return list.length === 0 || (await read($, error)) ? reply : { text: `0 of ${list.length} items need you: ${reply.text}` }
    }
    const count = isFiltered(chosen)
      ? `${shown.length} of ${list.length} item${list.length === 1 ? ' needs' : 's need'} you`
      : `${list.length} item${list.length === 1 ? ' needs' : 's need'} you`

    return { text: `${count}:\n\n${reply.text}` }
  }).catch(failed)

  on('command.run', { command: 'inbox-list' }, async ($, e) => {
    await refresh($)
    const list = await read($, items)
    const word = argsOf(e)
    const narrowed = filterItems(list, word)
    if (!narrowed && list.length > 0) {
      const projects = [...new Set(list.map(one => one.project))].join(', ')

      return { text: `"${word}" is neither a kind (${KINDS.map(kind => TAG[kind]).join(', ')}) nor a project in the inbox (${projects}).` }
    }

    return replyWith($, narrowed, word ? `Nothing in the inbox for "${word}".` : 'Nothing needs you.', true)
  }).catch(failed)

  on('command.run', { command: 'inbox-search' }, async ($, e) => {
    const query = argsOf(e)
    if (!query) {
      return { text: 'Usage: /inbox-search <words>' }
    }
    await refresh($)

    return replyWith($, searchItems(await read($, items), query), `No inbox item matches "${query}".`, true)
  }).catch(failed)

  on('command.run', { command: 'inbox-show' }, async ($, e) => {
    const beadId = argsOf(e).split(/\s+/)[0]
    if (!beadId) {
      return { text: 'Usage: /inbox-show <bead-id>' }
    }

    return withId($, beadId, async id => {
      const item = (await read($, items)).find(one => one.id === id)
      const view = await loadBead($, id, item?.blocks)
      const how = item?.kind === 'approval' ? `/approve ${id} [note] or /reject ${id} <reason>` : `/answer ${id} <text>`
      const reason = (await read($, notSaved))[id]
      const body = item && !view.error ? `${beadText(view)}\n\nReply: ${how}` : beadText(view)

      return { text: reason ? `Not saved: ${reason}\n\n${body}` : body }
    })
  }).catch(failed)

  on('command.run', { command: 'inbox-dismiss' }, async ($, e) => {
    const beadId = argsOf(e).split(/\s+/)[0]
    if (!beadId) {
      return { text: 'Usage: /inbox-dismiss <id>' }
    }

    return withId($, beadId, id => resolve($, id, DISMISSED))
  }).catch(failed)

  on('command.run', { command: 'answer' }, async ($, e) => {
    const parsed = splitIdAndText(argsOf(e))
    if (!parsed?.text) {
      return { text: 'Usage: /answer <gate-id> <answer>' }
    }

    return withId($, parsed.id, id => resolve($, id, parsed.text))
  }).catch(failed)

  on('command.run', { command: 'approve' }, async ($, e) => {
    const parsed = splitIdAndText(argsOf(e))
    if (!parsed) {
      return { text: 'Usage: /approve <gate-id> [note]' }
    }

    return withId($, parsed.id, id => resolve($, id, parsed.text ? `APPROVED. ${parsed.text}` : 'APPROVED'))
  }).catch(failed)

  on('command.run', { command: 'reject' }, async ($, e) => {
    const parsed = splitIdAndText(argsOf(e))
    if (!parsed?.text) {
      return { text: 'Usage: /reject <gate-id> <reason>' }
    }

    return withId($, parsed.id, id => resolve($, id, `REJECTED: ${parsed.text}`))
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

  // Every item, grouped by kind; the pane scrolls.
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const list = await read($, items)
    const failure = await read($, error)
    const at = await read($, now)
    const chosen = await read($, filter)
    const reasons = await read($, notSaved)

    if (failure) {
      return <Text color="warning" wrap="wrap">{failure}</Text>
    }
    const filtered = isFiltered(chosen)
    if (list.length === 0 && !filtered) {
      return <Text dimColor>Nothing needs you. Gates filed by agents show here.</Text>
    }

    const shown = filtered ? applyFilter(list, chosen) : list
    const mixed = isMixed(list)
    const colorOf = projectColors(list.map(one => one.project))
    const rows: RenderChildren[] = []
    if (filtered) {
      rows.push(
        <Box key="filter" flexDirection="row" gap={1} marginBottom={1}>
          <Text wrap="wrap">{filterText(chosen, shown.length, list.length)}</Text>
          <Button key="filter:clear" label="Clear" dimColor onPress={() => setFilter($, {})} />
        </Box>,
      )
    }
    if (shown.length === 0) {
      rows.push(<Text dimColor>Nothing matches the filter.</Text>)
    }
    for (const kind of KINDS) {
      const group = shown.filter(one => one.kind === kind)
      if (group.length === 0) {
        continue
      }
      rows.push(
        <Text bold color={COLOR[kind]}>
          {TAG[kind].toUpperCase()} ({group.length})
        </Text>,
      )
      for (const item of group) {
        const reason = reasons[item.id]
        rows.push(
          <Box key={item.id} flexDirection="column" marginBottom={1}>
            <Box flexDirection="row" gap={1}>
              {mixed ? (
                <Button
                  key={`${item.id}:tag`}
                  plain
                  onPress={() => setFilter($, { ...chosen, project: item.project })}
                >
                  <Text color={CHIP_TEXT} backgroundColor={colorOf(item.project)}>
                    {chipText(item.project)}
                  </Text>
                </Button>
              ) : null}
              <Text wrap="wrap">
                <Text bold>{item.title}</Text>{' '}
                <Text dimColor>
                  {item.id}
                  {item.blocks ? ` → ${item.blocks}` : ''} · {age(item.createdAt, at)}
                </Text>
              </Text>
            </Box>
            {reason ? (
              <Text color="warning" wrap="wrap">
                Not saved: {reason}
              </Text>
            ) : null}
            {item.details ? (
              <Text dimColor wrap="wrap">
                {truncate(item.details, 600)}
              </Text>
            ) : null}
            <Box flexDirection="row" gap={1}>
              <Button key={`${item.id}:open`} label="Open" onPress={() => openBead($, item.id)} />
              {item.kind === 'approval' ? (
                <Button key={`${item.id}:approve`} label="Approve" onPress={() => pressAnswer($, item.id, 'APPROVED')} />
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
                onPress={() => pressAnswer($, item.id, DISMISSED)}
              />
            </Box>
          </Box>,
        )
      }
    }

    return <Box flexDirection="column">{rows}</Box>
  })
}
