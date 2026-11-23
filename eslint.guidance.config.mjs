/**
 * Guidance placement: the plugin's subagents (agents/*.md) and any CLAUDE.md,
 * AGENTS.md or skill, linted by eslint-plugin-conventions' `guidance` preset
 * on @eslint/markdown. `npm run lint:guidance` runs it, from CI (check.yml)
 * and the pre-push hook (`hook:verify`). Every rule is at error; findings that predate
 * it live in .guidance-suppressions.json, which may only shrink
 * (`npm run lint:guidance -- --prune-suppressions` after a fix).
 */
import markdown from "@eslint/markdown";
import { configs as conventions } from "eslint-plugin-conventions";

const { guidance } = conventions;

export default [
  {
    // ESLint lints *.js, *.mjs and *.cjs by default; here they would only
    // report the main config's disable comments as unknown rules.
    ignores: [
      "**/*.{js,mjs,cjs}",
      "**/node_modules/**",
      "**/dist/**",
      "**/coverage/**",
      "**/.next/**",
      "**/.turbo/**",
    ],
  },
  { plugins: { markdown } },
  {
    ...guidance,
    rules: Object.fromEntries(
      Object.keys(guidance.rules).map((rule) => [rule, "error"]),
    ),
  },
];
