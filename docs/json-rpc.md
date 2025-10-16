# copilot-language-server — Inline Completions & Next Edit Suggestions

This document describes the JSON-RPC methods and payloads needed to
implement two features: Inline Completions (as-you-type) and Next Edit
Suggestions (NES). The shapes and behavior are inferred from copilot.vim
(and compatible clients such as sidekick.nvim). The server should
implement these contracts to interoperate with those clients.

Global notes

- All positions/character offsets use UTF-16 code-unit indexing
  unless the `initialize` exchange negotiates a different `offsetEncoding`.
- Be tolerant to small variations: copilot.vim accepts either an array
  result or an object `{ items: [...] }` for inline completions.
- Clients may cancel in-flight requests; support LSP request
  cancellation.

Inline Completions (textDocument/inlineCompletion)

Purpose

- Provide single-line or short multi-line completions while the user
  types. Supports cycling through additional candidates and partial
  acceptance.

Method

- `textDocument/inlineCompletion` (request)

Params (typical)
{
"textDocument": { "uri": "file:///path/to/file" },
"position": { "line": 10, "character": 5 }, // UTF-16
"formattingOptions": { "insertSpaces": true, "tabSize": 2 },
"context": { "triggerKind": 1 }
}

Notes

- `triggerKind` distinguishes auto vs invoked vs cycling requests.
- Clients may call the same method again with a different
  `triggerKind` to request extra/cycling candidates.

Result (either form accepted)

- Array form:
  [
  {
  "insertText": "console.log('hi')",
  "range": { "start": {"line":10,"character":5}, "end": {"line":10,"character":5} },
  "command": { "title": "cmd", "command": "server.cmd", "arguments": [...] },
  "uuid": "optional-stable-id",
  "displayText": "optional display"
  }
  ]

- Object form:
  { "items": [ /* same items as above */ ] }

Item fields the client uses

- `insertText` (string) — text to insert (client expects string).
- `range` — LSP Range using UTF-16 offsets.
- `command`? — optional LSP `Command` to execute when accepted.
- `uuid`? — optional stable identifier for telemetry.

Behavioral expectations

- Cancellation: server must honor request cancellation.
- Cycling: repeated requests with `context.triggerKind` should return
  additional or alternate candidates; client deduplicates by `insertText`.
- Partial accept: client notifies the server with
  `textDocument/didPartiallyAcceptCompletion` when a partial accept
  occurs (see Telemetry below).

Telemetry / notifications (client → server)

- `textDocument/didShowCompletion` — payload: `{ item }` when a candidate is shown.
- `textDocument/didPartiallyAcceptCompletion` — payload: `{ item, acceptedLength }`.
  - `acceptedLength` is measured in UTF-16 code units.

Example minimal flow

1. Client sends `textDocument/inlineCompletion` at cursor position.
2. Server replies with array of items or `{ items: [...] }`.
3. Client shows preview; on show it sends `didShowCompletion`.
4. If user accepts partially, client sends `didPartiallyAcceptCompletion`.
5. If the item contains `command`, client may call `workspace/executeCommand` instead of inserting text.

Next Edit Suggestions (NES) — batched edits

Purpose

- Provide larger, multi-line or multi-hunk edits (refactorings / whole
  suggestions). NES is return-as-a-batch and applied atomically; sidekick.nvim
  uses `textDocument/copilotInlineEdit` for this flow.

Method

- `textDocument/copilotInlineEdit` (request)

Params (typical)

- Use LSP position params created with the client offset encoding, for
  example: `vim.lsp.util.make_position_params(0, client.offset_encoding)`.
- Include `textDocument.version` (buffer version) in the params.

Example params
{
"textDocument": { "uri": "file:///x", "version": 42 },
"position": { "line": 10, "character": 5 }
}

Result

- Single response: `{ "edits": [ NesEdit, ... ] }`

NesEdit (fields used by clients)

- `textDocument`: { uri: string, version: integer }
- `range`: LSP Range (start/end positions; encoding = negotiated encoding)
- `text`: string — replacement/newText for the range
- `command`? — optional LSP `Command` to execute after apply
- `uuid`? — optional stable id for telemetry

Client behavior

- Clients convert server-provided UTF-16 positions to buffer byte indices
  using their `client.offset_encoding` and compute diffs/hunks for UI.
- Apply edits atomically with `apply_text_edits` using the client's
  offset encoding helper.
- After applying edits, client executes any supplied `command` via
  `workspace/executeCommand` / client exec functions.

Example NES result
{
"edits": [
{
"textDocument": { "uri":"file:///x", "version": 42 },
"range": { "start": {"line": 5, "character": 0}, "end": {"line": 7, "character": 0} },
"text": "function foo()\n return 42\nend\n",
"command": { "title": "postApply", "command": "server.postApply", "arguments": [ ... ] },
"uuid": "edit-123"
}
]
}

Behavioral expectations

- No streaming required — server returns the edits array in one
  response. Clients show diffs and allow review before apply.
- Provide stable ids (`uuid`) if you want accept/reject telemetry.
- Support `workspace/executeCommand` for server-supplied commands.

Shared implementation notes

- Offset encoding: negotiate in `initialize`. Most clients expect UTF-16
  — convert positions and lengths accordingly. In Lua/Neovim use
  `vim.fn.strutf16len` or `vim.lsp.util` helpers; in JS the string
  `.length` matches UTF-16 code units.
- Tolerance: accept both result shapes for inline completions (array or
  `{ items: [] }`) to be compatible with copilot.vim.
- Cancellation: inline completion requests are cancelled by the client
  frequently — handle cancellations cleanly.
- Telemetry: if you emit `uuid`/`solutionId`, support client-side
  notifications (`didShowCompletion`, `didPartiallyAcceptCompletion`) to
  collect telemetry or learning signals.

Quick comparison table

| Feature                     | Method                           | Request shape                                            | Result shape                                                                                                        |
| --------------------------- | -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Inline completions          | `textDocument/inlineCompletion`  | `{ textDocument, position, formattingOptions, context }` | Array `[item,...]` or `{ items: [...] }` (items include `insertText`, `range`, optional `command`, optional `uuid`) |
| Next Edit Suggestions (NES) | `textDocument/copilotInlineEdit` | Position params + `textDocument.version`                 | `{ edits: [ { textDocument, range, text, command?, uuid? } ] }`                                                     |

If you want, I can:

- Produce JSON Schema files for the two methods (`inlineCompletion` item, `copilotInlineEdit` NesEdit), or
- Add minimal example server stubs (Node/TS or simple JSON-RPC) that implement these two endpoints for local testing.

Which would you like next?
