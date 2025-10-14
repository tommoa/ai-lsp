# copilot-language-server — JSON-RPC Method Reference

This document describes the JSON-RPC methods used between the
copilot.lua client and the copilot-language-server. It is derived from
client usage patterns in `copilot.lua` (not the server source).

A few global notes

- All positions/character offsets use UTF-16 code-unit indexing.
- The client usually sends `params._ = true` to coerce empty tables
  into JSON objects; servers should ignore unknown fields.
- Many request `params` are produced by `util.get_doc_params()` in the
  client. See "Common params" below for the shape.

**Common params**

- These are the fields typically sent for completions and panel
  requests. The client builds them with `util.get_doc_params()`.

Example (informal JSON):
{
"doc": {
"uri": "file:///path/to/file",
"version": 42,
"relativePath": "src/foo.js",
"insertSpaces": true,
"tabSize": 2,
"indentSize": 2,
"position": { "line": 10, "character": 5 }
},
"textDocument": { "uri": "file:///path/to/file", "version": 42,
"relativePath": "src/foo.js" },
"position": { "line": 10, "character": 5 }
}

Notes

- `position.character` is the UTF-16 character offset in the line.
- Panel requests add `panelId: string` to `params`.

**Methods (client -> server)**

- **`workspace/didChangeConfiguration`** — notification
  - Purpose: provide workspace/client settings to the server.
  - Params (example):
    { "settings": { /_ copilot settings _/ } }
  - Settings keys: see `SettingsOpts.md` in copilot.lua. Examples:
    - `inlineSuggest.enable`
    - `advanced.inlineSuggestCount`
    - `advanced.listCount`
    - `debug.*`, `editor.*`, etc.
  - Response: none (notification).

- **`$/setTrace`** — notification
  - Purpose: enable/disable LSP trace on the server.
  - Params: { "value": "off" | "messages" | "verbose" }
  - Response: none (notification).

- **`checkStatus`** — request
  - Purpose: check Copilot sign-in / telemetry status.
  - Params (optional): { "options": { "localChecksOnly": boolean } }
  - Result: { "user"?: string, "status": "OK"|"NotAuthorized"|"NoTelemetryConsent" }

- **`signInInitiate`** — request
  - Purpose: start permanent sign-in (device flow).
  - Params: {} (empty)
  - Result: may include { "verificationUri"?: string, "userCode"?: string }

- **`signInConfirm`** — request
  - Purpose: confirm sign-in flow completion for `userId`.
  - Params: { "userId": string }
  - Result: { "status": string, "error"?: { "message": string }, "user"?: string }

- **`signOut`** — request
  - Purpose: sign out current Copilot auth session.
  - Params: {} (empty)
  - Result: unspecified (treat as generic success response)

- **`getVersion`** — request
  - Purpose: get server version.
  - Params: {} (empty)
  - Result: { "version": string }

- **`notifyAccepted`** — request
  - Purpose: inform server a completion was accepted.
  - Params: { "uuid": string, "acceptedLength"?: integer }
  - Notes: `acceptedLength` is the UTF-16 length of the accepted
    completion as computed by the client.
  - Result: unspecified

- **`notifyRejected`** — request
  - Purpose: inform server that a set of shown suggestions were
    rejected/dismissed.
  - Params: { "uuids": string[] }
  - Result: unspecified

- **`notifyShown`** — request
  - Purpose: inform server that a suggestion was displayed to the
    user.
  - Params: { "uuid": string }
  - Result: unspecified

- **`getCompletions`** — request
  - Purpose: request inline completions for the current doc/position.
  - Params: `util.get_doc_params()` shape (see "Common params").
  - Result: { "completions": [ completion ] }

  completion (object) fields
  - `displayText`: string — presentation text shown in UI.
  - `position`: { line: integer, character: integer } — suggested
    insertion position.
  - `range`: { "start": { line, character }, "end": { line,
    character } } — LSP-style range (UTF-16 offsets).
  - `text`: string — full completion text to insert.
  - `uuid`: string — unique id for telemetry/accept/reject events.
  - `partial_text`: string? — optional partial text for partial
    accept flows.

  - Notes: the client caches `params` and the request id so it can
    cancel in-flight requests (the client calls `client:cancel_request(id)`).

- **`getCompletionsCycling`** — request
  - Purpose: fetch additional / cycling completions to append to the
    existing list.
  - Params: same shape as `getCompletions` (client passes previous
    params it used for `getCompletions`).
  - Result: same as `getCompletions` ({ "completions": [...] }).
  - Notes: the client filters out duplicate `text` values and merges
    new suggestions into the current list.

- **`getPanelCompletions`** — request
  - Purpose: begin generation of many solutions for the Panel view.
  - Params: `util.get_doc_params()` extended with `panelId: string`.
    The client updates `params.doc.position.character` to the cursor
    UTF-16 index before calling this.
  - Result (initial): an object containing at least
    `{ "solutionCountTarget": integer }` (client reads
    `result.solutionCountTarget`).
  - Flow: after the request, the server should send `PanelSolution`
    notifications for each solution, followed by a
    `PanelSolutionsDone` notification.

**Server -> Client notifications handled by client**

- **`PanelSolution`** — notification (server -> client)
  - Payload (typedef `copilot_panel_solution_data` used in client):
    {
    "panelId": string,
    "completionText": string,
    "displayText": string,
    "range": { "start": { "line": int, "character": int },
    "end": { "line": int, "character": int } },
    "score": number,
    "solutionId": string
    }
  - Client behavior: panel displays each solution; `solutionId` is
    used for accept/telemetry.

- **`PanelSolutionsDone`** — notification
  - Payload: { "panelId": string, "status": "OK"|"Error",
    "message"?: string }
  - Client behavior: marks panel done or shows an error.

- **`statusNotification`** — notification
  - Purpose: server status updates consumed by the client
    (`copilot.status` handler).

- **`window/showDocument`** — request/notification handled by client
  - Payload: { "uri": string, "external"?: boolean,
    "takeFocus"?: boolean, "selection"?: boolean }
  - Result (client -> server response): { "success": boolean }
  - Notes: the client maps `window/showDocument` to `util.show_document`.

**Implementation notes for server authors**

- Use UTF-16 indexing for all positions and lengths.
- Be tolerant to extra/unknown keys; the client may send `params._` or
  other metadata.
- For `getPanelCompletions`, prefer streaming solutions as
  `PanelSolution` notifications and then a `PanelSolutionsDone` final
  notification. Include `solutionCountTarget` in the immediate
  response so client can show progress.
- Make `uuid` stable and unique per suggestion so telemetry/accept/
  reject flows can reference it.
- `notifyAccepted` may include `acceptedLength` (UTF-16) — record if
  you need acceptance metrics.

If you want, I can also generate a machine-readable JSON Schema file
for each method (useful for server stubs).
