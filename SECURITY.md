# Security

The workers promise to be read-only, and the plugin enforces it: every tool call a worker makes goes through `checkWorkerCall` in [hooks/rules.ts](hooks/rules.ts) before it runs.

**Report a bypass** (a worker that wrote, sent, deleted or ran something it should not) privately through [GitHub's private vulnerability reporting](https://github.com/ofri-peretz/subagent-gateway/security/advisories/new). Include the worker, the tool call or command, and the plugin version. Please don't open a public issue for it.

Fixes for a bypass ship as a patch release, with a test that refuses the reported call.

The plugin makes no network or model calls of its own, and stores only daily counts on your machine.
