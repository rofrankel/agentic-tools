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
  }
}

// A closed gate is answered. A closed bead still labelled attn: is finished
// work waiting on the human's review or feedback, so it stays.
const isWanted = (one: RawGate): boolean => {
  if (one.issue_type === 'gate') {
    return one.status !== 'closed' && (one.await_type === undefined || one.await_type === 'human')
  }

  return (one.labels ?? []).some(label => label.startsWith('attn:'))
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
    ],
  ],
  [
    'Commands',
    [
      '/inbox                       open the full list (grouped by kind, with details and buttons)',
      '/answer <id> <text>          answer an item',
      '/approve <id> [note]         approve (answer "APPROVED")',
      '/reject <id> <reason>        reject (answer "REJECTED: ...")',
      '/inbox-open <id>             open a bead in its own pane (full details, comments, what it blocks)',
      '/inbox-help                  this help',
      'These run at once, even mid-turn. In the pane: Open (the bead in its own pane), Approve, Answer… / Reject… (fills the prompt), Dismiss (agent uses its judgment).',
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
      'Agents call the ask_human tool (kind, question, details, blocks). Decisions, approvals and questions become a human gate labelled attn:<kind>, blocking the given bead or a new "Follow up: ..." bead.',
      'Review and feedback block nothing: the bead itself is labelled attn:review / attn:feedback, with the request as a comment.',
      'A repeated question (an agent retrying) is matched to the item already filed, not filed again.',
      'The manager and every new subagent are told to use it instead of asking in prose.',
      'Backup: when a subagent finishes with questions in prose, Haiku extracts them and files them, marked "(auto-extracted)". Skipped when the report says "User questions: none".',
      'You can file one by hand: bd gate create --blocks <id> --title "<question>" --reason "<details>", then bd label add <gate-id> attn:decision',
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
}

const first = (stdout: string): RawBead | undefined => {
  const parsed: unknown = jsonFrom(stdout, [])
  const one: unknown = Array.isArray(parsed) ? parsed[0] : parsed

  return typeof one === 'object' && one !== null && 'id' in one ? (one as RawBead) : undefined
}

const toRef = (raw: RawBead): BeadRef => ({
  id: raw.id,
  title: raw.title ?? '',
  status: raw.status ?? '',
  type: raw.issue_type ?? '',
})

// `show` is `bd show <id> --json`, `comments` is `bd comments <id> --json`,
// `blocked` is `bd show` of the bead a gate blocks, when it is one.
export const parseBead = (show: string, comments: string, blocked?: string): BeadView | undefined => {
  const raw = first(show)
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
  const parsedComments: unknown = jsonFrom(comments, [])
  const blockedRaw = blocked ? first(blocked) : undefined

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
    comments: (Array.isArray(parsedComments) ? parsedComments : [])
      .filter((one): one is { author?: string; text: string; created_at?: string } => typeof one?.text === 'string')
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
