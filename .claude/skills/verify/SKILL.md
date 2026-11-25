---
name: verify
description: Load this checkout's plugin in a real session and read the routed task's result, before committing.
---

# Verify a change by running it

`claude plugin test` drives the hooks with fixtures; this runs the plugin the way a user does.
Paste what you ran and saw into the commit's `Verified-by:` receipt.

## Boot

```sh
claude plugin validate --strict .
claude plugin test .
claude --plugin-dir . -p "list the files under agents/ and say what each worker reads" --output-format stream-json --verbose
```

Ready means validate and test exit 0 and the session starts with the plugin listed.

## Drive and inspect

Run a prompt that should route to the worker the change touches, and read the stream: which agent
ran, on which model, that it stayed read-only, and the report it returned. For a UI change, run
the same in an interactive session and look at the band above the prompt and the Agents view.

## Feature map

| Feature | Reach it by | Working means |
| --- | --- | --- |
| Manifest and marketplace | `claude plugin validate --strict .` | exit 0 |
| Hook routing and UI | `claude plugin test .` | every test passes |
| Worker routing | a reading prompt in `claude --plugin-dir .` | a worker from `agents/` runs on Haiku and returns a short report |
| Read-only workers | ask a worker to edit a file | the edit is refused |
| Same-file warning | two agents editing one file | the Agents view warns |
| Savings count | the band after a routed task | tokens saved, counted from real usage |
| Agents list stays in sync | `node --experimental-strip-types scripts/agents.mjs --check` | exit 0 |

## When it fails

Fix the plugin, not this skill. A row that no longer runs is fixed in its own commit. After three
failed rounds, stop and show the person the output.
