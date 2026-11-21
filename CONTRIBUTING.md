# Contributing

## Run it from your checkout

```
claude --plugin-dir .
```

A session started this way loads the plugin from this folder (and keeps its own savings file, apart from an installed copy's).

## Before a pull request

```
claude plugin validate .
claude plugin test .
```

Both run on every push and pull request.

## Where things live

- [hooks/rules.ts](hooks/rules.ts): pure rules, tested directly: the workers, routing, the read-only guard, counting, tips.
- [hooks/register.tsx](hooks/register.tsx): the hooks and the band, Savings pane and Agents view.
- [types/index.d.ts](types/index.d.ts): stored values. Change a stored shape only with a step that reads the older one; history must survive an upgrade.

## Adding a worker

1. Add it to `WORKERS` in `hooks/rules.ts`: a description that starts with "Use first…", a prompt that says what to report and what never to do, Haiku, and the fewest tools that work.
2. Teach `checkWorkerCall` what it may run, with a test of what it must refuse.
3. Name it in `HANDOFF_RULE`, and in the README's worker table.

## Counting

Numbers must be measured, not estimated. A change to what is counted needs a test with real-shaped usage, and a line in the README's "How savings are counted".
