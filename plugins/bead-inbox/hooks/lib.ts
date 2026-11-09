import type { AttnItem, AttnKind, BeadRef, BeadView } from '../types'

export const KINDS: readonly AttnKind[] = ['approval', 'decision', 'question', 'review', 'feedback']

export const TAG: Record<AttnKind, string> = {
  approval: 'approve',
  decision: 'decide',
  question: 'answer',
  review: 'review',
  feedback: 'feedback',
}

export const COLOR: Record<AttnKind, string> = {
  approval: 'warning',
  decision: 'claude',
  question: 'suggestion',
  review: 'permission',
  feedback: 'subtle',
}

const PROJECT_PREFIX = 'project:'

// Chip backgrounds: black text reads on each, on light and dark themes alike.
const PROJECT_COLORS: readonly string[] = [
  '#f28b82', '#fbbc66', '#fff475', '#b5e550', '#5fd38d', '#6fe0d0',
  '#7cc4fa', '#a0a8ff', '#d7aefb', '#fdb5dc', '#d2b48c', '#c0c8d0',
]

export const CHIP_TEXT = '#000000'

// FNV-1a, folded: short, similar names must still spread across the colors.
const hashOf = (text: string): number => {
  let hash = 0x811c9dc5
  for (const char of text) {
    hash = Math.imul(hash ^ (char.codePointAt(0) ?? 0), 16777619)
  }

  return (hash ^ (hash >>> 16)) >>> 0
}

// A project's name picks its color, so it keeps that color from session to
// session. One that would match another project on screen takes the next free
// color instead: at a glance, two projects must never look alike.
export const projectColors = (projects: readonly string[]): ((project: string) => string) => {
  const colorAt = (index: number) => PROJECT_COLORS[index % PROJECT_COLORS.length] ?? CHIP_TEXT
  const chosen = new Map<string, string>()
  for (const project of [...new Set(projects)].sort()) {
    const start = hashOf(project)
    const free = PROJECT_COLORS.map((_, step) => colorAt(start + step)).find(
      color => ![...chosen.values()].includes(color),
    )
    chosen.set(project, free ?? colorAt(start))
  }

  return project => chosen.get(project) ?? colorAt(hashOf(project))
}

export const chipText = (project: string): string => ` ${truncate(project, 16)} `

// bd splits labels on commas, and a folder name may hold spaces.
export const cleanProject = (name: string | undefined): string | undefined => {
  const clean = (name ?? '')
    .trim()
    .replace(/^project:/i, '')
    .replace(/[\s,]+/g, '-')
    .toLowerCase()

  return clean === '' ? undefined : clean
}

export const projectLabel = (project: string): string => `${PROJECT_PREFIX}${project}`

export const labelledProject = (labels: readonly string[]): string | undefined =>
  labels.find(one => one.startsWith(PROJECT_PREFIX))?.slice(PROJECT_PREFIX.length)

// An untagged bead goes by its id prefix, which differs between repos.
export const projectOf = (id: string, labels: readonly string[]): string =>
  labelledProject(labels) ?? /^(.+)-[^-]+$/.exec(id)?.[1] ?? id

// With one project in the list a tag on every row would say nothing.
export const isMixed = (list: AttnItem[]): boolean => new Set(list.map(one => one.project)).size > 1

export const folderName = (path: string): string | undefined =>
  path.split(/[\\/]/).filter(Boolean).pop()

export type RawGate = {
  id: string
  title: string
  description?: string
  status?: string
  issue_type?: string
  await_type?: string
  labels?: string[]
  created_at: string
}

export const isKind = (value: unknown): value is AttnKind =>
  typeof value === 'string' && (KINDS as readonly string[]).includes(value)

// Review and feedback ask for notes on work; they never block it.
export const isFeedbackKind = (kind: AttnKind): boolean => kind === 'review' || kind === 'feedback'

// A human gate made by a formula carries no attn: label; those are sign-offs.
export const toItem = (raw: RawGate): AttnItem => {
  const label = (raw.labels ?? []).find(one => one.startsWith('attn:'))?.slice(5)
  const description = raw.description ?? ''
  const blocks = /Ad-hoc gate blocking (\S+)/.exec(description)?.[1]
  const details = description
    .replace(/^Ad-hoc gate blocking \S+\s*/, '')
    .replace(/^Reason:\s*/, '')
    .trim()

  return {
    id: raw.id,
    title: raw.title,
    kind: isKind(label) ? label : 'approval',
    details,
    blocks,
    createdAt: raw.created_at,
    isGate: raw.issue_type === 'gate',
    label: label === undefined ? undefined : `attn:${label}`,
    project: projectOf(raw.id, raw.labels ?? []),
  }
}

// A closed gate is answered. A closed bead still labelled attn: is finished
// work waiting on the human's review or feedback, so it stays.
const isWanted = (one: RawGate): boolean => {
  if (one.issue_type === 'gate') {
    return one.status !== 'closed' && (one.await_type === undefined || one.await_type === 'human')
  }

  // A closed bead stays only when it asks for review or feedback on finished
  // work; a closed decision, approval or question was settled some other way.
  const labels = (one.labels ?? []).filter(label => label.startsWith('attn:'))
  return one.status === 'closed'
    ? labels.some(label => label === 'attn:review' || label === 'attn:feedback')
    : labels.length > 0
}

// Takes the stdout of each bd list run (open gates, attn:-labelled issues) and
// merges them, a gate that is also labelled appearing once.
export const parseGates = (...stdouts: string[]): AttnItem[] => {
  const byId = new Map<string, RawGate>()
  for (const stdout of stdouts) {
    const parsed: unknown = jsonFrom(stdout, [])
    for (const one of Array.isArray(parsed) ? (parsed as RawGate[]) : []) {
      byId.set(one.id, one)
    }
  }

  return sortItems([...byId.values()].filter(isWanted).map(toItem))
}

export const sortItems = (list: AttnItem[]): AttnItem[] =>
  [...list].sort(
    (a, b) =>
      KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.createdAt.localeCompare(b.createdAt),
  )

export const statusText = (list: AttnItem[]): string | undefined => {
  if (list.length === 0) {
    return undefined
  }
  const counts = KINDS.map(kind => [kind, list.filter(one => one.kind === kind).length] as const)
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${count} ${TAG[kind]}`)

  return `⚑ ${list.length} need${list.length === 1 ? 's' : ''} you · ${counts.join(' · ')}`
}

export const age = (createdAt: string, now: number): string => {
  const minutes = Math.max(0, Math.round((now - Date.parse(createdAt)) / 60_000))
  if (minutes < 60) {
    return `${minutes}m`
  }
  if (minutes < 48 * 60) {
    return `${Math.round(minutes / 60)}h`
  }

  return `${Math.round(minutes / 1440)}d`
}

// A kind by its name or its tag: "approval" and "approve" are the same list.
export const kindNamed = (word: string): AttnKind | undefined => {
  const lower = word.trim().toLowerCase()

  return KINDS.find(kind => kind === lower || TAG[kind] === lower || `${kind}s` === lower)
}

// "/inbox-list decide", "/inbox-list api", "/inbox-list project:api": a kind
// or a project narrows the list; undefined when the word names neither.
export const filterItems = (list: AttnItem[], filter: string): AttnItem[] | undefined => {
  const word = filter.trim()
  if (word === '') {
    return list
  }
  const kind = kindNamed(word)
  if (kind) {
    return list.filter(one => one.kind === kind)
  }
  const project = cleanProject(word)

  return list.some(one => one.project === project) ? list.filter(one => one.project === project) : undefined
}

// Every word of the query, in any case, somewhere in the item.
export const searchItems = (list: AttnItem[], query: string): AttnItem[] => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  return list.filter(one => {
    const haystack = [one.id, one.title, one.details, one.project, one.kind, TAG[one.kind], one.blocks ?? '']
      .join(' ')
      .toLowerCase()

    return words.every(word => haystack.includes(word))
  })
}

// The inbox as plain text, for a command's reply: a remote client shows the
// transcript, not the band or the pane.
export const listText = (list: AttnItem[], now: number, options: { details?: boolean; projects?: boolean } = {}): string => {
  const withProject = options.projects ?? isMixed(list)
  const lines: string[] = []
  for (const kind of KINDS) {
    const group = list.filter(one => one.kind === kind)
    if (group.length === 0) {
      continue
    }
    lines.push(`${lines.length > 0 ? '\n' : ''}${TAG[kind].toUpperCase()} (${group.length})`)
    for (const item of group) {
      const where = withProject ? `[${item.project}] ` : ''
      const blocks = item.blocks ? ` → ${item.blocks}` : ''
      lines.push(`  ${item.id}  ${where}${item.title}${blocks} · ${age(item.createdAt, now)}`)
      if (options.details && item.details) {
        lines.push(...truncate(item.details, 600).split(/\r?\n/).map(line => `      ${line}`))
      }
    }
  }

  return lines.join('\n')
}

// Room for a long bead in one transcript row on every surface.
const BEAD_TEXT_MAX = 8000

// The bead pane's content as plain text: /inbox-show over Remote Control.
export const beadText = (view: BeadView): string => {
  if (view.error) {
    return `${view.id}: ${view.error}`
  }
  const meta = [
    view.type,
    view.status,
    view.priority === null ? '' : `P${view.priority}`,
    view.assignee ? `@${view.assignee}` : '',
    view.labels.length > 0 ? view.labels.join(', ') : '',
  ].filter(Boolean)
  const lines = [`${view.title} (${view.id})`, meta.join(' · '), `created ${view.createdAt} · updated ${view.updatedAt}`]
  for (const section of view.sections) {
    lines.push('', `${section.heading}:`, section.text)
  }
  if (view.blocks) {
    lines.push('', `Blocks: ${view.blocks.id} ${view.blocks.title} (${view.blocks.type}, ${view.blocks.status})`)
    if (view.blocks.description) {
      lines.push(truncate(view.blocks.description, 1500))
    }
  }
  if (view.deps.length > 0) {
    lines.push('', `Depends on (${view.deps.length}):`, ...view.deps.map(dep => `  ${dep.id} ${dep.title} (${dep.type}, ${dep.status})`))
  }
  lines.push('', `Comments (${view.comments.length}):`)
  for (const comment of view.comments) {
    lines.push(`  ${comment.author} · ${comment.createdAt}`, ...comment.text.split(/\r?\n/).map(line => `    ${line}`))
  }

  return truncate(lines.join('\n'), BEAD_TEXT_MAX)
}

// "u1y" stands for "ait-u1y": the prefix may be left out when one item's id
// ends that way. With none the id goes to bd as typed, which reads short ids
// too; with several the person has to say which.
export const matchId = (list: AttnItem[], typed: string): { id: string } | { ambiguous: string[] } => {
  const lower = typed.trim().toLowerCase()
  const exact = list.find(one => one.id.toLowerCase() === lower)
  if (exact) {
    return { id: exact.id }
  }
  const ends = list.filter(one => one.id.toLowerCase().endsWith(`-${lower}`))
  if (ends.length > 1) {
    return { ambiguous: ends.map(one => one.id) }
  }

  return { id: ends[0]?.id ?? typed.trim() }
}

// "/answer bd-12 use postgres" → { id: "bd-12", text: "use postgres" }
export const splitIdAndText = (args: string): { id: string; text: string } | undefined => {
  const match = /^\s*(\S+)\s*([\s\S]*)$/.exec(args)
  if (!match?.[1]) {
    return undefined
  }

  return { id: match[1], text: (match[2] ?? '').trim() }
}

export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max - 1)}…`

const QUESTION_HINT =
  /\?|\b(decide|decision|approv\w*|confirm|your call|let me know|should I|which (option|approach)|need(s)? (your|human|a human)|sign[- ]off|feedback|preference)\b/i

// A report that says it has no questions for the user is taken at its word:
// its other lines ("merge?", "push?" under manager notes) are not for the human.
const NO_USER_QUESTIONS = /\buser questions\b[*_\s]*:[*_\s]*(none|n\/a)\b/i

export const mightHoldQuestions = (answer: string): boolean =>
  !NO_USER_QUESTIONS.test(answer) && QUESTION_HINT.test(answer)

export type Extracted = { kind: AttnKind; question: string; details: string }

export const parseExtracted = (text: string): Extracted[] => {
  const start = text.indexOf('[')
  const end = text.lastIndexOf(']')
  if (start < 0 || end < start) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(text.slice(start, end + 1))
    if (!Array.isArray(parsed)) {
      return []
    }

    return parsed
      .filter(
        (one): one is { kind: unknown; question: string; details?: unknown } =>
          typeof one === 'object' && one !== null && typeof one.question === 'string',
      )
      .map(one => ({
        kind: isKind(one.kind) ? one.kind : 'question',
        question: one.question.trim(),
        details: typeof one.details === 'string' ? one.details.trim() : '',
      }))
      .filter(one => one.question.length > 0)
      .slice(0, 8)
  } catch {
    return []
  }
}

export const HELP: readonly (readonly [string, readonly string[]])[] = [
  [
    'What it shows',
    [
      'Beads that need you: open human gates, and any open issue labelled attn:approval, attn:decision, attn:question, attn:review or attn:feedback.',
      'Status line: a count by kind. Band above the prompt: the top 3, approvals first, then oldest. Toast: when a new one arrives.',
      'It reads bd every 15s and after any bd command or subagent return. Viewing costs no model tokens, and it survives /clear.',
      'Projects: when the inbox holds more than one project, each row carries a colored project tag. The color comes from the name, so a project usually keeps it across sessions; if two would match, one takes the next free color. A bead\'s project is its project:<name> label, or else its id prefix.',
    ],
  ],
  [
    'Commands',
    [
      '/inbox                       open the full list (grouped by kind, with details and buttons)',
      '/inbox-list [kind|project]   the list as text, with details; narrowed to a kind (approve, decide…) or a project',
      '/inbox-search <words>        items whose id, title, details or project hold every word',
      '/inbox-show <id>             a bead as text: details, comments, what it blocks',
      '/answer <id> <text>          answer an item',
      '/approve <id> [note]         approve (answer "APPROVED")',
      '/reject <id> <reason>        reject (answer "REJECTED: ...")',
      '/inbox-dismiss <id>          dismiss without an answer (the agent uses its judgment)',
      '/inbox-open <id>             open a bead in its own pane (full details, comments, what it blocks)',
      '/inbox-help                  this help',
      'An id may leave out its prefix (u1y for ait-u1y) when only one item in the inbox ends that way.',
      'These run at once, even mid-turn, and cost no model tokens. In the pane: Open (the bead in its own pane), Approve, Answer… / Reject… (fills the prompt), Dismiss (agent uses its judgment).',
      'Over Remote Control (/rc) the status line, band and panes may not show: /inbox, /inbox-list, /inbox-search and /inbox-show reply in the transcript, and answering works the same.',
    ],
  ],
  [
    'What answering does',
    [
      'Decision / approval / question gate: closes it with your answer as the reason and comments the answer on the bead it blocked (now unblocked in bd ready).',
      'Review / feedback: your notes become a comment on the work bead, its attn: label is swapped for human-feedback, and it is reopened if it was closed. The agent addresses the notes, then removes human-feedback.',
      'Other labelled issue: comments your answer on it and removes the attn: label; the issue stays open for the agent.',
      'The manager also gets one hidden line naming your answer, so it can act without asking you.',
    ],
  ],
  [
    'How items get filed',
    [
      'Agents call the ask_human tool (kind, question, details, blocks, project). Decisions, approvals and questions become a human gate labelled attn:<kind>, blocking the given bead or a new "Follow up: ..." bead.',
      'Each item is labelled project:<name>: the project of the bead it concerns if that has one, else the project the agent passed, else the name of the session\'s folder.',
      'Review and feedback block nothing: the bead itself is labelled attn:review / attn:feedback, with the request as a comment.',
      'A repeated question (an agent retrying) is matched to the item already filed, not filed again.',
      'The manager and every new subagent are told to use it instead of asking in prose.',
      'Backup: when a subagent finishes with questions in prose, Haiku extracts them and files them, marked "(auto-extracted)". Skipped when the report says "User questions: none".',
      'You can file one by hand: bd gate create --blocks <id> --title "<question>" --reason "<details>", then bd label add <gate-id> attn:decision,project:<name>',
    ],
  ],
  [
    'Troubleshooting',
    [
      '"No beads database found": start Claude Code in the repo that holds .beads, or set BEADS_DIR.',
      '"bd failed": the pane shows bd\'s error. The plugin finds bd on PATH, or the real bd.exe behind an npm shim.',
      'Pane not showing at startup: it opens by itself only at 144+ columns; use /inbox.',
      'After editing the plugin: /reload-plugins.',
    ],
  ],
]

// Pane ids take letters, digits, _ and - only, up to 64.
export const paneIdFor = (beadId: string): string =>
  `bead-${beadId.replace(/[^A-Za-z0-9_-]/g, '_')}`.slice(0, 64)

type RawBead = {
  id: string
  title?: string
  status?: string
  issue_type?: string
  priority?: number
  labels?: string[]
  assignee?: string
  owner?: string
  created_at?: string
  updated_at?: string
  description?: string
  design?: string
  acceptance_criteria?: string
  notes?: string
  close_reason?: string
  dependencies?: RawBead[]
  comments?: { author?: string; text: string; created_at?: string }[]
}

const beads = (stdout: string): RawBead[] => {
  const parsed: unknown = jsonFrom(stdout, [])

  return (Array.isArray(parsed) ? parsed : [parsed]).filter(
    (one): one is RawBead => typeof one === 'object' && one !== null && 'id' in one,
  )
}

const toRef = (raw: RawBead): BeadRef => ({
  id: raw.id,
  title: raw.title ?? '',
  status: raw.status ?? '',
  type: raw.issue_type ?? '',
})

// The bead a gate blocks, read from bd's "Ad-hoc gate blocking X" description.
export const gateTarget = (description: string | undefined): string | undefined =>
  /Ad-hoc gate blocking (\S+)/.exec(description ?? '')?.[1]

// `show` is one `bd show <id> [<blocked id>] --include-comments --json`: the
// bead, and for a gate the bead it blocks, read in a single bd run.
export const parseBead = (show: string, beadId: string, blocksId?: string): BeadView | undefined => {
  const all = beads(show)
  const raw = all.find(one => one.id === beadId) ?? all[0]
  if (!raw) {
    return undefined
  }
  const fields: [string, string | undefined][] = [
    ['Description', raw.description],
    ['Design', raw.design],
    ['Acceptance criteria', raw.acceptance_criteria],
    ['Notes', raw.notes],
    ['Close reason', raw.close_reason],
  ]
  const sections = fields.flatMap(([heading, text]) =>
    typeof text === 'string' && text.trim() !== '' ? [{ heading, text: text.trim() }] : [],
  )
  const target = blocksId ?? gateTarget(raw.description)
  const blockedRaw = target === undefined ? undefined : all.find(one => one.id === target && one !== raw)

  return {
    id: raw.id,
    title: raw.title ?? '',
    status: raw.status ?? '',
    type: raw.issue_type ?? '',
    priority: typeof raw.priority === 'number' ? raw.priority : null,
    labels: raw.labels ?? [],
    assignee: raw.assignee ?? raw.owner,
    createdAt: raw.created_at ?? '',
    updatedAt: raw.updated_at ?? '',
    sections,
    deps: (raw.dependencies ?? []).map(toRef),
    comments: (raw.comments ?? [])
      .filter(one => typeof one?.text === 'string')
      .map(one => ({ author: one.author ?? '', text: one.text, createdAt: one.created_at ?? '' })),
    blocks: blockedRaw ? { ...toRef(blockedRaw), description: blockedRaw.description?.trim() ?? '' } : undefined,
  }
}

// bd may print notices (upgrade hints, sync messages) around its --json
// output: read the outermost JSON array or object, wherever it starts.
export const jsonFrom = (stdout: string, fallback: unknown): unknown => {
  const text = stdout.trim()
  if (text === '') {
    return fallback
  }
  try {
    return JSON.parse(text)
  } catch {
    // fall through to the scan
  }
  for (const [open, close] of [['[', ']'], ['{', '}']] as const) {
    const start = text.indexOf(open)
    const end = text.lastIndexOf(close)
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1))
      } catch {
        // try the other shape
      }
    }
  }
  throw new Error(`bd printed no JSON: ${truncate(text, 200)}`)
}

// The id from `bd gate create --json` (an object, or a one-element array).
export const createdId = (stdout: string): string | undefined => {
  try {
    const parsed = jsonFrom(stdout, undefined)
    const one: unknown = Array.isArray(parsed) ? parsed[0] : parsed
    if (typeof one === 'object' && one !== null && typeof (one as { id?: unknown }).id === 'string') {
      return (one as { id: string }).id
    }
  } catch {
    // fall back to the text
  }

  return /"id"\s*:\s*"([^"]+)"/.exec(stdout)?.[1]
}

// The id `bd q` prints, ignoring any notice lines around it.
export const quickId = (stdout: string): string | undefined =>
  stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => /^[A-Za-z0-9][\w.-]*-[\w.]+$/.test(line))
    .pop()

export const sameQuestion = (a: string, b: string): boolean =>
  a.replace(/\s+/g, ' ').trim().toLowerCase() === b.replace(/\s+/g, ' ').trim().toLowerCase()

// Two projects can ask the same thing ("Merge to main?"); only the same
// question from the same project is a retry.
export const isRepeat = (item: AttnItem, question: string, project: string | undefined): boolean =>
  (project === undefined || item.project === project) &&
  (sameQuestion(item.title, question) || sameQuestion(item.title, `Follow up: ${truncate(question, 100)}`))
