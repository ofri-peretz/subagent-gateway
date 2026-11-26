# Changelog

## Unreleased

- **`scripts/model-mix.mjs`**: which model each subagent actually ran on, counted from Claude Code's own transcripts (`subagents/agent-*.meta.json` + `.jsonl`), with tokens, Haiku share and empty runs by agent type. It replaces trusting the savings counters. Metas with no transcript are reported, not counted. First run (7 days): 542 runs, 23% on Haiku by count, about 2% by tokens; workers came back empty in 6 of 126 runs.

## 1.0.1

- The seven workers ship as agent files (`agents/*.md`), so plugin listings show them; CI checks they match the rules.
- README images are plain Markdown with a PNG preview, so listings that don't draw HTML or SVG show them.
- Documentation, support and privacy links in the manifest for directory listings.

## 1.0.0

- **`mcp-reader`**, a seventh read-only worker for mail, Slack, analytics and other connected (MCP) tools. Its guard lets through only tools whose action searches, lists, gets or reads.
- **Missed hand-offs by size:** one main-conversation read of 8K tokens or more counts, as do 5 reads in a row; reads from connected tools count too. The tip names the worker that fits.
- **Tips** for edits with no test, lint or type check, for waiting with `sleep`, for 3 or more test runs or installs at once, and for 6 or more agents at once. One of each per prompt.
- **`/gateway agents <word>`** shows only the agents whose task, type or files match.
- A worker refused by its read-only guard is no longer counted as a hand-off.
- History rows from any earlier 0.6+ version load with every count filled in: upgrades keep your history.
- Tests and validation run on every push. README rewritten, with a FAQ, privacy, and measured hook latency.

## 0.7.0

- The Agents view shows each agent's new tokens, context, current tool and edited files, and flags two running agents that edit the same file.
- Interlace icon and full marketplace metadata.

## 0.6.1

- Cheaper model no longer counts cache reads (it read about 30× too high).
- An agent continued over several turns counts as one run, timed per turn.

## 0.6.0

- Honest numbers: the gateway's own saving apart from what all subagents keep out; each agent's starting context not counted; no estimated time. A new history starts, as the old one credited every subagent to the gateway.
- More hand-offs: a hand-off line beside each prompt, look-only `general-purpose` tasks on Haiku, a tip and a count when the main conversation reads 5 files in a row.

## 0.5.1

- Savings from several open sessions add up, where the last session to write used to overwrite the others.

## 0.5.0

- The Agents view: a live tree of every running agent, nested sub-agents and teammates.

## 0.4.0

- Read-only enforcement for the workers; savings per prompt, per day and all time; usage-limit forecast; a Savings pane.

## 0.3.0 and earlier

- Haiku workers, compact button, running-subagent chip; subagent routing in place of per-prompt model switching.
