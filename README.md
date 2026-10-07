# agent-tree

## Summary

A Claude Code plugin that draws the current session's subagents as a live tree in a side pane. You can see who spawned whom and what each agent is doing right now, so you don't have to dig through the transcript to find out.

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

The pane opens on its own when a session starts, and each session shows its own tree, so switching sessions switches the tree too. If you've closed it, `/agent-tree` brings it back.

![The agent-tree pane showing a session with six subagents](docs/screenshot.png)

(The screenshot uses made-up sample data.)

Your session sits at the top, named after its project folder, and each agent hangs under the one that spawned it. The dot shows where an agent is at: blue while it runs, green when it's done, red if it failed, grey if it was stopped. A running agent's card also shows the tool it's using right now, and a small pulse runs down the line into it.

Scroll over the tree to zoom in and out around the pointer. Zoom all the way out and the whole tree fits again.

If you open a subagent's transcript, its card gets an outline so you can find it in the tree.

Colors follow your Claude Code theme, color-blind themes included. With `auto`, they follow your system's light or dark setting. In the terminal you get a plain text version of the tree.

## License

MIT. See [LICENSE](LICENSE).
