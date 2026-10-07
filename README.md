# agent-tree

## Summary

A Claude Code plugin that draws your session's subagents as a live graph in a side pane. You can see who spawned whom, what each agent is doing right now, and how long its tool calls take, so you don't have to dig through the transcript to find out.

## Installation

You'll need a Claude Code build that supports function-hook plugins. I've tested it on 2.1.288.

Clone the repo:

```bash
git clone https://github.com/VanillaFairy/agent-tree.git
```

To try it in a single terminal session:

```bash
claude --plugin-dir /path/to/agent-tree
```

To have it in every session, desktop app included, add the folder to `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`:

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_DIRS": "/path/to/agent-tree"
  }
}
```

If you load several plugin folders this way, separate them with `;` on Windows and `:` everywhere else.

## How to use

The pane pops open on its own the first time a subagent starts. You can also open it whenever you like with `/agent-tree`.

![The agent-tree pane: graph, selected agent, tool timeline](docs/screenshot.png)

(The screenshot uses made-up sample data.)

The main session sits at the top of the graph, and each agent hangs under the one that spawned it. Running agents are blue with a pulsing dot, finished ones green, failed ones red and stopped ones grey. Every card shows the agent's type, how many tools it has called, how long it's been going, and the tool it's running right now.

Use `−` and `+` to zoom and the arrows to pan. `Fit` brings the whole graph back into view. `Hide finished` clears out branches where nothing is still running or failed.

Pick an agent from the dropdown to look at it more closely. You'll see what it's doing now and its last 14 tool calls as a timeline, colored by kind, where a longer bar means a slower call. From there, `Center` zooms in on it, `Collapse` folds its children into a `+N` badge, and `Stop` kills it if it's still running. Once an agent finishes, you also get its final message and a link to its transcript.

Hover over a card or a timeline row if the text is cut off.

Colors follow your Claude Code theme, color-blind themes included. With `auto`, they follow your system's light or dark setting. In the terminal you get a text version of the tree with the same controls.

## License

MIT. See [LICENSE](LICENSE).
