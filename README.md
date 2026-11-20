<img src=".claude-plugin/icon.png" alt="Interlace" width="72" align="right">

# subagent-gateway

A Claude Code plugin that sends the heavy reading through cheap, read-only Haiku subagents, shows every running agent live, and counts the tokens it kept out of your main conversation, per prompt and over time. Part of [Interlace](https://interlace.tools): check what coding agents ship.

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

Built-in subagents go through the gateway too: `Explore` runs on Haiku and `general-purpose` on Sonnet, both at medium effort. A `general-purpose` task that only looks (find, list, summarize…) and says nothing about changing anything runs on Haiku. Forks, and agents that set their own model, are left alone.

**Getting the work handed off.** While the gateway is on, it adds one rule to the main conversation's system prompt: hand searches, logs, test runs, docs, diffs and tickets to the matching worker, and read only the files you are about to change. When the main conversation still reads 5 files in a row itself, you get one tip per prompt, and it counts as a missed hand-off.

## What you see

**The band above the prompt:**

```
⬡ log-reader ▲ 42s +1   prompt 42K   today 180K by gateway · 1.4M by all subagents      5h 62% → out 15:40   Week 49%   ⟲ Ctx 41%   Savings
```

- **⬡ chip:** while agents run, it shows the newest one, its model, how long it has run, and how many more are running. Click it to open the Agents view.
- **prompt / today:** tokens the gateway's workers kept out of your main conversation, for the last prompt and for today, next to what all subagents kept out.
- **5h / Week:** your usage limits. `→ out 15:40` appears when your current pace would use up the limit before it resets.
- **⟲ Ctx:** how full the context is. Click it to compact.

**The Agents view** (click the ⬡ chip, or `/gateway agents`) shows every agent in the session as a live tree: subagents, the sub-agents they started (nested under their parent) and teammates. For each one you see its model, type, status (running, waiting, idle, ✓ done, ✗ failed) and how long it has run, with its task underneath. It refreshes every 2 seconds while anything is still going.

```
2 running · 1 idle or done
● general-purpose · running · 1m · 48K new · ctx 61K
  fix the flaky test
  → Edit Login.tsx
  edited Login.tsx, auth.ts
  ⚠ Login.tsx: another agent edited it too
└ ▲ Explore · running · 20s · 9K new · ctx 22K
    find the spec
    → Grep useLogin
▲ log-reader · ✓ · 42s · 31K new · ctx 35K
  read the CI log
```

Each row also shows the agent's new tokens so far (cache reads left out), how large its context is now, the tool it is running, and the files it edited.

**Collisions.** When two agents that are both running edit the same file, or an agent edits a file the main conversation edited after that agent started, both rows get a ⚠, the band's chip shows ⚠ and how many agents collide, and one toast names the file and both agents. Agents in separate worktrees edit separate paths, so they never collide.

**The Savings pane** (`/gateway` or the Savings button) shows:

- tokens kept out for today, the last 7 days and all time: by the gateway, by all subagents, and how many tokens ran on a cheaper model because the gateway routed them; with a 14-day trend
- hand-offs: worker runs, other agent runs and missed hand-offs
- this session per prompt
- tokens kept out per agent type
- your usage limits, with the forecast

## How savings are counted

- **Kept out:** the tokens a subagent took into its own context beyond what its first request held (system prompt, tools, its task, which the main conversation has too), less the report it returned. Measured from each subagent's real token usage. Forks and nested subagents don't count.
- **By gateway** counts the workers only. Other subagents keep their reading out of the main conversation with or without this plugin, so they show under **All subagents**; the gateway's part for them is **Cheaper model**, the new tokens they took in and wrote on Haiku or Sonnet because it routed them (cache reads are left out: every request re-reads the agent's own context).
- **Side by side:** how long agents ran in parallel. It is not counted as time saved, because they might never have run one after another.

History stays on your machine, one row per day. No prompt text is stored or sent anywhere, and the plugin makes no model calls of its own.

## Commands and prefixes

- `/gateway` opens the Savings pane, and `/gateway agents` the Agents view. `/gateway off` and `/gateway on` turn the workers and subagent routing off or on.
- Start a prompt with `o `, `s ` or `h ` to run that one prompt on Opus, Sonnet or Haiku. The next prompt goes back to your model. Past 50K tokens of context you get a warning, because the switch re-reads everything.

## Where it works

The Claude Code CLI and the desktop app (Code tab).

## Development

```
claude plugin validate .
claude plugin test .
```

## Changes

- **0.7.0:** Interlace icon and full marketplace metadata. The Agents view shows each agent's tokens, context, current tool and edited files, and flags two running agents that edit the same file.
- **0.6.1:** fixes: Cheaper model no longer counts cache reads (it read about 30× too high), and an agent continued over several turns counts as one run, timed per turn.
- **0.6.0:** honest numbers: the gateway's own saving apart from what all subagents keep out, each agent's starting context no longer counted, no estimated time; a new history starts, as the old one credited every subagent to the gateway. More hand-offs: a hand-off rule in the system prompt, look-only `general-purpose` tasks on Haiku, a tip and a count when the main conversation reads 5 files in a row, plainer worker descriptions.
- **0.5.1:** savings from several open sessions add up, where the last session to write used to overwrite the others.
- **0.5.0:** the Agents view: a live tree of every running agent, nested sub-agents and teammates, opened from the band's chip.
- **0.4.0:** Read-only enforcement for the workers; token and time savings per prompt, per day and all time; usage-limit forecast; a Savings pane with the running subagents; fixes for a prefix carrying over to later turns and for subagent effort not being applied; a simpler band.
- **0.3.0:** Haiku workers, compact button, running-subagent chip.
- **0.2.0:** per-prompt model switching removed (it cost more than it saved); subagents routed instead.
- **0.1.0:** first version.

## Credits

By Ofri Peretz, as part of [Interlace](https://interlace.tools). MIT licensed; see LICENSE.
