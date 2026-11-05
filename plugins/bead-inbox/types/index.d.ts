export type AttnKind = 'approval' | 'decision' | 'question' | 'review' | 'feedback'

export type AttnItem = {
  id: string
  title: string
  kind: AttnKind
  details: string
  blocks?: string
  createdAt: string
  isGate: boolean
  label?: string
  project: string
}

export type BeadRef = { id: string; title: string; status: string; type: string }

export type BeadComment = { author: string; text: string; createdAt: string }

export type BeadView = {
  id: string
  title: string
  status: string
  type: string
  priority: number | null
  labels: string[]
  assignee?: string
  createdAt: string
  updatedAt: string
  sections: { heading: string; text: string }[]
  deps: BeadRef[]
  comments: BeadComment[]
  blocks?: BeadRef & { description: string }
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'bead-inbox': {
      items: AttnItem[]
      error: string | null
      now: number
      views: Record<string, BeadView>
      loading: string[]
    }
  }
}
