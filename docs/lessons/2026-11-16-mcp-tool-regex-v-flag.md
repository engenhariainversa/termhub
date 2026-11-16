---
symptom: "tools/list input schemas ... patterns any regex engine reads: SyntaxError: Invalid regular expression: /.../v: Invalid character in character class"
tags: [mcp, zod, schema, tests]
evidence: fixed
card: TER-1064
agent: claude
date: 2026-11-16
---
## Cause

`src/mcp/tools-schema.test.ts` compiles every `pattern` of every MCP tool's JSON schema with the `v`
flag, the way strict engines (Rust's `regex`, used by some MCP clients) read character classes. Under `v`,
a literal `-` at the end of a class such as `[A-Za-z0-9._-]` must be escaped, or it is a syntax error, even though the same
regex is fine in plain JavaScript. A `z.string().regex(...)` on a tool input becomes such a `pattern`.

## Fix

Keep regexes out of MCP tool inputs when the value is checked elsewhere anyway (`add_repo`'s `key` is
matched against the project's own keys, and `ensureWorkspace` applies the folder charset). When a pattern is
really needed, escape the `-` (`[A-Za-z0-9._\-]`) so it reads the same with and without `v`; check with
`node -e 'new RegExp("<class>", "v")'`.

## How to check

`npm test -w @termhub/server -- src/mcp/tools-schema.test.ts` passes.
