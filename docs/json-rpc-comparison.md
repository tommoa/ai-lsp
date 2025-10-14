# copilot-language-server — JSON-RPC Comparison

This document compares the JSON-RPC methods inferred from two
clients: `copilot.lua` (Neovim Lua client) and `copilot.vim` (Vimscript
client). Use this to design a language server compatible with both
clients (or to decide which method names to expose).

Summary

- `copilot.lua` (the Lua client) calls custom methods such as
  `getCompletions`, `getCompletionsCycling`, and
  `getPanelCompletions`, and expects server notifications
  `PanelSolution` / `PanelSolutionsDone` for the Panel flow.
- `copilot.vim` (the Vimscript client) calls different method names
  — notably `textDocument/inlineCompletion` for inline completions and
  `textDocument/didShowCompletion` / `textDocument/didPartiallyAcceptCompletion`
  notifications for UI telemetry.
- A server aiming for compatibility should support both method sets or
  implement canonical methods and map the alternate names to them.

Methods observed in copilot.lua client (from `lua/copilot/api/init.lua`)

- workspace/didChangeConfiguration (notification)
- $/setTrace (notification)
- checkStatus (request)
- signInInitiate (request)
- signInConfirm (request)
- signOut (request)
- getVersion (request)
- notifyAccepted (request)
- notifyRejected (request)
- notifyShown (request)
- getCompletions (request) -> { completions: [ { displayText, position, range, text, uuid, partial_text } ] }
- getCompletionsCycling (request) -> similar completions response
- getPanelCompletions (request) -> immediate response containing at least `solutionCountTarget`, followed by server notifications `PanelSolution` / `PanelSolutionsDone`

Server -> client notifications the Lua client expects:

- PanelSolution (payload: panelId, completionText, displayText, range, score, solutionId)
- PanelSolutionsDone (payload: panelId, status, message?)
- statusNotification
- window/showDocument (client handles this)

Methods observed in copilot.vim client (from `autoload/copilot.vim`)

- textDocument/inlineCompletion (request)
  - The vim client builds `params` differently but includes:
    - `textDocument`: { uri }
    - `position`: via `copilot#util#AppendPosition()` (UTF-16 aware)
    - `formattingOptions`: { insertSpaces, tabSize }
    - `context`: { triggerKind }
  - The result the vim client expects is either an array or an object
    containing `items` (it treats either `result` or `result.items`).
  - Cycling requests: `textDocument/inlineCompletion` is reused with
    `context.triggerKind` changed (client sets `s:inline_invoked` vs
    `s:inline_automatic`).
- textDocument/didShowCompletion (notification)
  - Sent by client to inform server which item was shown; payload is
    `{'item': item}` where `item` is a completion entry.
- textDocument/didPartiallyAcceptCompletion (notification)
  - Sent when user partially accepts a suggestion. Payload contains
    `item` and `acceptedLength`.
- getVersion (request) — client requests server version
- signIn (call/request) — initiates sign-in (vim client calls `signIn` and expects `verificationUri` and `userCode` or status `AlreadySignedIn`)
- signOut (call/request)
- workspace/executeCommand (request) — used during sign-in to open browser
- Other uses: copilot#Request and copilot#Call wrappers are used for other calls such as `checkStatus`.

Mapping and differences

- Inline completions method
  - copilot.lua: `getCompletions` (and `getCompletionsCycling`)
  - copilot.vim: `textDocument/inlineCompletion`
  - Recommendation: implement both endpoints or accept both names and
    forward them to a single internal handler. Ensure both accept the
    `util.get_doc_params()`-like shape or the `textDocument` + `position`
    - `formattingOptions` + `context` shape.

- Panel flow
  - copilot.lua: `getPanelCompletions` request + `PanelSolution` / `PanelSolutionsDone` notifications
  - copilot.vim: `textDocument/inlineCompletion` is primarily for inline; copilot.vim also implements a panel UI differently (not visible in the single file examined). The `copilot.vim` plugin historically interacts with the language server using `workspace/executeCommand` and custom notifications, depending on server implementation.
  - Recommendation: support the `getPanelCompletions` pattern (request
    then `PanelSolution` stream) and also ensure `textDocument/inlineCompletion`
    can optionally be used to fetch panel-like results if the client
    asks for it.

- Telemetry / show/accept notifications
  - copilot.lua: `notify_shown`, `notify_accepted`, `notify_rejected` (custom named methods)
  - copilot.vim: uses `textDocument/didShowCompletion` and `textDocument/didPartiallyAcceptCompletion` notifications.
  - Recommendation: support both the custom `notifyShown`/`notifyAccepted`/`notifyRejected` and the `textDocument/didShowCompletion`/`textDocument/didPartiallyAcceptCompletion` names (map them to the same telemetry handlers).

- Sign-in methods
  - copilot.lua: `signInInitiate` + `signInConfirm` (initiate + confirm)
  - copilot.vim: `signIn` (request) and then the client may call `signInConfirm` or `workspace/executeCommand` per server details.
  - Recommendation: accept `signIn` as alias for `signInInitiate` (or route both to same implementation). Provide both `signInConfirm` and `signIn`/`signInInitiate` compatibility depending on input/output shapes.

- Settings / configuration
  - Both clients send `workspace/didChangeConfiguration` at init; the `SettingsOpts.md` in copilot.lua enumerates server settings the Lua client expects. Implement these settings (or ignore unknown keys) and allow clients to set `settings` under the LSP `settings` field.

- Position encoding
  - Both clients use UTF-16 encoding for positions/lengths. Ensure server uses UTF-16 semantics.

Compatibility guidance for server implementers

- Expose both sets of method names (the `copilot.lua` names and the
  `copilot.vim` names) or implement a single canonical handler and
  register both names to call it.
- Normalize incoming params: accept both `util.get_doc_params()` style
  (doc/textDocument/position) and the compact `textDocument` +
  `formattingOptions` + `context` used by copilot.vim.
- Stream panel solutions via `PanelSolution` notifications and finish
  with `PanelSolutionsDone`. Also provide an immediate response to
  `getPanelCompletions` that includes `solutionCountTarget`.
- Support telemetry/UX notifications from both clients.
- Keep `uuid` stable and include it in suggestions so either client can
  reference suggestions for accept/reject telemetry.

References

- `copilot.lua` (client) — analyzed files: `lua/copilot/api/init.lua`,
  `lua/copilot/suggestion/init.lua`, `lua/copilot/panel/init.lua`,
  `lua/copilot/util.lua` and related modules.
- `copilot.vim` (client) — analyzed file: `autoload/copilot.vim` from
  `github/copilot.vim` repository.

If you want, I can:

- Modify `docs/json-rpc.md` to include a compatibility table for each
  method (both names, param examples), or
- Generate a server stub that registers both sets of method names and
  normalizes incoming params to a single internal shape.

Which would you like next?
