# bead-inbox

A Claude Code plugin that shows which [beads](https://github.com/steveyegge/beads) need a human: approvals, decisions, questions, reviews and feedback.

A long-running manager session with many subagents keeps asking questions. Each subagent's questions scroll out of view when the next one reports back. bead-inbox files every question as a bead and keeps the open ones in view, so nothing gets lost. Reading and answering them costs no model tokens, and the inbox survives `/clear`.

## Requirements

- A Claude Code build that loads plugin hook modules (`hooks/hooks.json` with `"modules"`)
- [`bd`](https://github.com/steveyegge/beads) on your PATH, or installed with npm (the plugin finds the real `bd.exe` behind npm's Windows shim)
- Claude Code started in a repo with a beads database (`.beads/`), or `BEADS_DIR` set. There is one inbox per repo.

## Install

```
/plugin marketplace add rofrankel/agentic-tools
/plugin install bead-inbox@rofrankel
```

## What you see

- **Status line:** a count by kind, e.g. `⚑ 3 need you · 1 approve · 2 decide`
- **Band above the prompt:** the top 3 items, approvals first, then oldest
- **Toast** when a new item arrives
- **`/inbox` pane:** everything, grouped by kind, with details and buttons (Open, Approve, Answer…, Reject…, Dismiss)
- **Bead pane** (Open, or `/inbox-open <id>`): the full bead, its comments, and what it blocks

It reads `bd` every 15 seconds, and also after any `bd` command or subagent return.

## Commands

| Command | Does |
| --- | --- |
| `/inbox` | Open the full list |
| `/answer <id> <text>` | Answer an item |
| `/approve <id> [note]` | Approve (answers `APPROVED`) |
| `/reject <id> <reason>` | Reject (answers `REJECTED: ...`) |
| `/inbox-open <id>` | Open a bead in its own pane |
| `/inbox-help` | Usage help |

All of them run immediately, even while the agent is mid-turn.

## How items get filed

The plugin registers an `ask_human` tool and tells the manager and every subagent to use it instead of asking in prose.

- **Decision, approval or question:** creates a beads human gate labelled `attn:<kind>`. The gate blocks the bead in question, or a new "Follow up: ..." bead if none is given. The agent moves on to other ready work.
- **Review or feedback:** blocks nothing. The work bead itself is labelled `attn:review` or `attn:feedback`, with the request added as a comment.
- **Retries:** a repeated question is matched to the item already filed, so it isn't filed twice.
- **Backup:** when a subagent finishes with questions written in prose, Haiku extracts them and files them, marked "(auto-extracted)".

Anything else with an `attn:*` label, or any open human gate, shows up too, so you can file items by hand:

```
bd gate create --type human --blocks <id> --title "<question>" --reason "<details>"
bd label add <gate-id> attn:decision
```

## What answering does

- **Gate:** closes it with your answer as the reason, and adds the answer as a comment on the bead it blocked, which is now unblocked in `bd ready`.
- **Review or feedback:** your notes become a comment on the work bead. Its `attn:` label is swapped for `human-feedback`, and the bead is reopened if it was closed. The agent addresses the notes, then removes `human-feedback`.
- **Other labelled issue:** adds your answer as a comment and removes the `attn:` label.

The manager also receives one hidden line naming your answer, so it can act without asking you.

## Development

```
claude plugin validate plugins/bead-inbox
claude plugin test plugins/bead-inbox
```
