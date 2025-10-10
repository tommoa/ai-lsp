# ai-lsp

This project aims to copy the functionality of `copilot-language-server`, but providing some additional flexibility.

NOTE: This is currently very WIP.

## Missing features

- Figure out why `copilot-language-server` requires `textDocument/didFocus`
  notifications.
- Do next edit completions with `textDocument/copilotInlineEdit`.
  - Parameters require position and document.
  - Return back the following JSON:
    ```json
    {
      "edits": [
        {
          "range": {
            "start": { "line": 0, "character": 0 },
            "end": { "line": 0, "character": 0 }
          },
          "textDocument": { "uri": "<uri>" },
          "text": "...",
        }
      ]
    }
    ```

## Installation

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

## FAQ

### Why is this written in TypeScript?

I actually prefer writing things in Rust and C++, so those would have been more
natural languages for me to pick. But there are a couple of reasons why this
ended up being written in TypeScript.

1. I wanted to learn TypeScript - all of my normal work is in more low-level
   languages.
2. It seems (to me) to be relatively easy to arbitrarily import modules, which
   is helpful in the fast-moving AI space.
