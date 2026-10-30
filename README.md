# agentic-tools

Plugins, skills and tools for working with coding agents. Each entry says what it runs on: some are specific to one harness, others work with any agent or model.

## Contents

| Name | What it does | Runs on |
| --- | --- | --- |
| [bead-inbox](plugins/bead-inbox) | An inbox of the [beads](https://github.com/steveyegge/beads) human gates and reviews waiting on you, so questions from long-running agents and subagents don't get lost in scrollback. You answer them without spending model tokens. | Claude Code |

## Installing the Claude Code plugins

This repo is a Claude Code plugin marketplace. In Claude Code:

```
/plugin marketplace add rofrankel/agentic-tools
/plugin install bead-inbox@rofrankel
```

## Layout

```
.claude-plugin/marketplace.json   Claude Code's marketplace manifest
plugins/<name>/                   Claude Code plugins
skills/<name>/                    SKILL.md skills usable by any harness that reads them
mcp/<name>/                       MCP servers, for any MCP client
prompts/                          model-agnostic prompts and conventions
```

Folders appear as they get their first entry.

## License

[MIT](LICENSE)
