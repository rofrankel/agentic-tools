# bead-inbox

A Claude Code plugin that shows which [beads](https://github.com/steveyegge/beads) need a human: approvals, decisions, questions, reviews and feedback.

A long-running manager session with many subagents keeps asking questions. Each subagent's questions scroll out of view when the next one reports back. bead-inbox files every question as a bead and keeps the open ones in view, so nothing gets lost. Reading and answering them costs no model tokens, and the inbox survives `/clear`.

## Requirements

- A Claude Code build that loads plugin hook modules (`hooks/hooks.json` with `"modules"`)
- [`bd`](https://github.com/steveyegge/beads) on your PATH, or installed with npm (the plugin finds the real `bd.exe` behind npm's Windows shim)
- Claude Code started in a repo with a beads database (`.beads/`), or `BEADS_DIR` set. There is one inbox per database, so projects that share a database share an inbox.

## Install

```
/plugin marketplace add rofrankel/agentic-tools
/plugin install bead-inbox@rofrankel
```

## What you see

- **Status line:** a count by kind, e.g. `⚑ 3 need you · 1 approve · 2 decide`
- **Band above the prompt:** the top 3 items, approvals first, then oldest
- **Toast** when a new item arrives
- **`/inbox` pane:** everything, grouped by kind, with details and buttons (Open, Approve, Answer…, Reject…, Dismiss). It scrolls, so nothing is cut off. `/inbox [kind] [project:<name>]` filters it (a project includes its subprojects: `project:web` holds `web:api`, not `webapp`); in a mixed inbox each row's project tag is a button that filters to that project, and the filter bar's Clear shows everything again. Bare `/inbox` clears the filter.
- **Bead pane** (Open, or `/inbox-open <id>`): the full bead, its comments, and what it blocks. Markdown links (`[text](url)`) in descriptions and comments are drawn as links.

Only an interactive session polls; background agents and `claude -p` runs read `bd` only when a command or `ask_human` runs, so they don't add to lock contention. Each poll first takes a cheap signature of the beads store (for Dolt, each database's journal size and a hash of its manifest: file metadata and one small read, no `bd` process) and reads `bd` only when it changed, or once the list is a minute old. That lets the poll run every 10 seconds at almost no cost. A store it doesn't recognise falls back to reading `bd` every 60 seconds. It also reads after any `bd` command or subagent return, and at once after your answer.

### Answering is instant

An answered item leaves the band, status line and pane at once, before `bd` has written anything (a write can wait minutes on the database lock during a `bd dolt push`). A poll whose reads began before your answer can't bring it back. If the write fails, the item comes back where it was, marked **Not saved: <reason>**. Answering again redoes only what's missing: if your comment saved but the `attn:` label wouldn't come off, the retry only removes the label.

`bd` gets 120 seconds and one retry on a database-lock error (or on a timeout, except for commands that create something, which could land twice). An answer resubmitted within 2 minutes isn't saved twice, and the reply says so. A partial success says what failed. Pane buttons toast "saving…" and then the result.

### Projects

When the inbox holds more than one project, the band, the `/inbox` pane and the bead pane show a colored tag with the project's name, and toasts name the project. The color comes from the name, so a project usually keeps it across sessions; if two projects in the inbox would match, one takes the next free color. With a single project the tags stay hidden.

A bead's project is its `project:<name>` label, or its id prefix if it has none. To tag a bead by hand: `bd label add <id> project:<name>`.

## Commands

| Command | Does |
| --- | --- |
| `/inbox [kind] [project:<name>]` | Open the full list, optionally filtered, and print it |
| `/inbox-list [kind\|project]` | Print the list with details, optionally just one kind (`approve`, `decide`, `answer`, `review`, `feedback`) or one project |
| `/inbox-search <words>` | Print the items whose id, title, details or project contain every word |
| `/inbox-show <id>` | Print a bead: details, comments, and what it blocks |
| `/answer <id> <text>` | Answer an item |
| `/approve <id> [note]` | Approve (answers `APPROVED`) |
| `/reject <id> <reason>` | Reject (answers `REJECTED: ...`) |
| `/inbox-dismiss <id>` | Dismiss without an answer (the agent uses its judgment) |
| `/inbox-open <id>` | Open a bead in its own pane |
| `/inbox-help` | Usage help |

All of them run immediately, even while the agent is mid-turn, and none uses model tokens. An id can leave out its prefix (`/approve u1y` for `ait-u1y`) when only one item in the inbox ends that way.

### Remote Control

Commands sent from claude.ai or the mobile app through Remote Control (`/rc`) run in your local session like typed ones. The status line, band and panes may not show on the remote client, so do the whole loop with text commands: `/inbox` or `/inbox-list` to see what's waiting, `/inbox-show <id>` for one item, then `/answer`, `/approve`, `/reject` or `/inbox-dismiss`. Their replies show in the transcript.

## How items get filed

The plugin registers an `ask_human` tool and tells the manager and every subagent to use it instead of asking in prose.

- **Decision, approval or question:** creates a beads human gate labelled `attn:<kind>`. The gate blocks the bead in question, or a new "Follow up: ..." bead if none is given. The agent moves on to other ready work.
- **Review or feedback:** blocks nothing. The work bead itself is labelled `attn:review` or `attn:feedback`, with the request added as a comment.
- **Project:** each item is labelled `project:<name>`: the project of the bead it concerns if that bead has one, else the `project` the agent passed, else the name of the session's folder.
- **Retries:** a repeated question from the same project is matched to the item already filed, so it isn't filed twice.
- **Backup:** when a subagent finishes with questions written in prose, a model (Sonnet by default) extracts them and files them, marked "(auto-extracted)". A report that says `User questions: none` is skipped. If your agents file their own questions with `ask_human`, turn the backup off in `/config` to avoid duplicates.

Anything else with an `attn:*` label, or any open human gate, shows up too, so you can file items by hand:

```
bd gate create --type human --blocks <id> --title "<question>" --reason "<details>"
bd label add <gate-id> attn:decision,project:<name>
```

## What answering does

- **Gate:** closes it with your answer as the reason, and adds the answer as a comment on the bead it blocked, which is now unblocked in `bd ready`.
- **Review or feedback:** your notes become a comment on the work bead. Its `attn:` label is swapped for `human-feedback`, and the bead is reopened if it was closed. The agent addresses the notes, then removes `human-feedback`.
- **Other labelled issue:** adds your answer as a comment and removes the `attn:` label.

The manager also receives one hidden line naming your answer, so it can act without asking you.

Comment text (answers, notes) goes to `bd` on standard input, and the plugin prefers the real `bd.exe` over npm's `bd.cmd` shim, so a multi-line answer arrives whole. A gate's close reason is still a command-line argument (`bd gate resolve` reads it from no file): on an install with only the shim, a multi-line reason is cut at its first line, though the full answer still lands in the comment on the blocked bead.

## Settings

Set these in `/config`. Each defaults to the behaviour described above.

| Setting | Default | Does |
| --- | --- | --- |
| Extractor model | `sonnet` | The model the backup uses (`haiku`, `sonnet` or `opus`) |
| Auto-extract questions from subagent reports | on | Turn off when your agents file their own questions |
| Poll interval (seconds) | 0 (auto) | Auto: 10s with a store signature, 15s with a snapshot command, else 60s |
| Read bd only when the beads store changed | on | The store-signature check before each poll |
| Snapshot command | empty | A command that prints `{"gates": [...], "attn": [...], "error"?: "...", "started"?: <epoch seconds>}` in place of the plugin's two `bd list` calls, for setups where several sessions share one database and a cheaper shared reader exists. `gates` is what `bd list --type gate --status open --json --limit 0` prints, `attn` the `attn:*`-labelled list, `started` when the reads behind it began. Writes still go through `bd` |
| Snapshot force arguments | empty | Added to the snapshot command after the plugin's own writes, so the reader skips its cache |
| On-answered command | empty | Run after every saved answer (not awaited, 30s timeout, exit code ignored), with `BEAD_INBOX_ID` and `BEAD_INBOX_BLOCKS` set, so a dispatcher can act at once. Runs in background sessions too |

## Development

```
claude plugin validate plugins/bead-inbox
claude plugin test plugins/bead-inbox
```
