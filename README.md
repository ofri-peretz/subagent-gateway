# subagent-gateway

A Claude Code plugin that sends the heavy reading through cheap, read-only Haiku subagents and shows what that saved, in tokens and time, per prompt and over time.

Your main conversation stays on the model you chose. Repo searches, logs, test runs, diffs, docs and tickets go to six Haiku workers. They read the bulky material in their own context and hand back a short report, so your main conversation stays small. That matters because every reply re-reads the whole conversation.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install subagent-gateway --marketplace ofri-peretz/subagent-gateway
```

Answer `y` to add the marketplace, then pick a scope. From a shell:

```
claude plugin install subagent-gateway --marketplace ofri-peretz/subagent-gateway
```

In the Claude desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `ofri-peretz/subagent-gateway`, then Add plugin.

## Why subagents, and not switching models

Switching the main conversation to a cheaper model does not save usage. The prompt cache belongs to the model that wrote it, so the new model re-reads the whole conversation at full price. A subagent starts with a fresh, small context, so running it on Haiku costs nothing extra, and it keeps file dumps and logs out of your main context.

## The workers

| Worker | Does |
| --- | --- |
| `repo-searcher` | Finds files, usages and definitions; reports `path:line` with a short note |
| `log-reader` | Reads test output and CI logs; reports each failing case and its first error line |
| `test-runner` | Runs a test command once (Vitest, Jest, Cypress, Newman, `npm test`…) and reports totals and failures |
| `docs-reader` | Fetches a docs page or searches the web; answers one question with its source |
| `diff-reader` | Summarizes a git diff, branch or pull request, file by file |
| `ticket-reader` | Reads a Jira ticket or Confluence page through your Atlassian tools |

Claude hands them work when the task matches, and you can also ask for one by name ("use the log-reader on this CI log").

**They are read-only, and it is enforced.** Every tool call a worker makes is checked before it runs:

- Reading workers may run only read commands (`rg`, `cat`, `git diff`, `git log`, `gh pr view`, …), with no `;`, `&&`, redirects or `$(…)`.
- `test-runner` may also start test commands, which run your project's own suite.
- `ticket-reader` may only use Atlassian `get`, `search` and `list` tools: no edits, comments, transitions or messages.

If the check fails, the call is refused.

Built-in subagents go through the gateway too: `Explore` runs on Haiku and `general-purpose` on Sonnet, both at medium effort. Forks, and agents that set their own model, are left alone.

## What you see

**The band above the prompt:**

```
⬡ log-reader ▲ 42s +1   prompt 42K   today 180K saved · ≈6m      5h 62% → out 15:40   Week 49%   ⟲ Ctx 41%   Savings
```

- **⬡ chip:** while subagents run, it shows the newest one, its model, how long it has run, and how many more are running.
- **prompt / today:** tokens the workers kept out of your main conversation, for the last prompt and for today, plus the estimated time saved.
- **5h / Week:** your usage limits. `→ out 15:40` appears when your current pace would use up the limit before it resets.
- **⟲ Ctx:** how full the context is. Click it to compact.

**The Savings pane** (`/gateway` or the Savings button) shows:

- the subagents running now, with model and elapsed time
- totals for today, the last 7 days and all time, with a 14-day trend
- this session's savings per prompt
- top savers per worker
- your usage limits, with the forecast

## How savings are counted

- **Kept out:** the tokens a subagent took into its own context, less the report it returned. Measured from each subagent's real token usage. Forks and nested subagents don't count.
- **Time (≈):** subagents running side by side (measured), plus Haiku being about 20% faster than the main model (an estimate).

History stays on your machine, one row per day. No prompt text is stored or sent anywhere, and the plugin makes no model calls of its own.

## Commands and prefixes

- `/gateway` opens the Savings pane. `/gateway off` and `/gateway on` turn the workers and subagent routing off or on.
- Start a prompt with `o `, `s ` or `h ` to run that one prompt on Opus, Sonnet or Haiku. The next prompt goes back to your model. Past 50K tokens of context you get a warning, because the switch re-reads everything.

## Where it works

The Claude Code CLI and the desktop app (Code tab).

## Development

```
claude plugin validate .
claude plugin test .
```

## Changes

- **0.4.0:** Read-only enforcement for the workers; token and time savings per prompt, per day and all time; usage-limit forecast; a Savings pane with the running subagents; fixes for a prefix carrying over to later turns and for subagent effort not being applied; a simpler band.
- **0.3.0:** Haiku workers, compact button, running-subagent chip.
- **0.2.0:** per-prompt model switching removed (it cost more than it saved); subagents routed instead.
- **0.1.0:** first version.

## Credits

Created by Nitzan Biron; 0.4.0 by Ofri Peretz. MIT licensed.
