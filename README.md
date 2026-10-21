# Session tracker for Claude Code

A side panel for Claude Code that shows what a session is doing while it runs: which subagents are working and how far along they are, what the session costs, how full the context window is, which files changed (with diffs), what still needs your attention, and what went wrong along the way. History and open to-dos carry over between sessions.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install session-tracker --marketplace Acidichurricane/claude-session-tracker
```

Answer `y` to add the marketplace, then pick a scope (user scope loads it in every session).

From a shell:

```
claude plugin install session-tracker --marketplace Acidichurricane/claude-session-tracker
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `Acidichurricane/claude-session-tracker`, then Add plugin.

## Using it

The pane opens beside the transcript on wide terminals (144+ columns); anywhere else, type `/tracker`. Keys **1–6** switch tabs while the pane has focus; **b** goes back from a detail view.

| Tab | What it shows |
|---|---|
| **HUD** | Active workers first: a spinner, an emoji for what each is doing (🔎 search, ✏️ edit, 🧪 tests, 🌐 web…), progress and time left. Then the context window (gauge plus a bar of what fills it), your 5-hour and 7-day usage limits with reset times, session cost and tokens, the current query, todo progress, and counts of changed files, to-dos and issues. |
| **SQUAD** | A card per subagent with a pixel-art avatar generated from its id, status (working, standby, done, failed), progress and what the estimate rests on, its current action, turns, active time, tools, tokens and model. |
| **FILES** | Files changed by Edit/Write, grouped by folder with +/− counts; open one for its diffs, each tagged with the agent and query that made it. |
| **TODO** | Things you need to do or configure, and work left unfinished. Claude adds them as they come up through the mod's `track` tool; mark them done from the pane. Open items carry over to later sessions. |
| **ISSUES** | Tool errors, refused calls, failed or interrupted turns (detected automatically) plus difficulties Claude reports. |
| **LOG** | Past sessions with cost, files and issues; open one for its queries and changes. |

### How progress is estimated

For each working subagent, in order of preference:

1. its own todo list, when it keeps one (done items and pace so far);
2. the median length and tool count of past runs of the same agent type, remembered across sessions;
3. a first guess per agent type until two runs are on record (shown dimmed with "≈").

Estimates are capped at 95% and a run well past its typical length shows as "over" instead of a made-up time.

## Notes

- Edits made through shell commands (`sed`, scripts) are not tracked; only the Edit, Write and NotebookEdit tools are.
- Cost is the session total the engine reports (the same as `/cost`); a query's cost is the change in that total. Subagents show tokens, not dollars.
- The mod adds one tool (`mcp__session-tracker__track`) and a short system-prompt section asking Claude to use it.
- Data stays on your machine in the plugin's own store (the last 20 sessions).
