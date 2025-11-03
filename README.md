# ai-lsp

This project aims to copy the functionality of `copilot-language-server`, but providing some additional flexibility.

NOTE: This is currently very WIP.

## Configuration

The LSP server is configured via `initializationOptions` with the following structure:

```lua
init_options = {
  providers = {
    -- Provider configuration (e.g., API keys, custom settings)
    google = { ... },
    anthropic = { ... },
  },
  -- Global default model used by all modes
  model = "google/gemini-flash-latest",

  -- Mode-specific configuration (optional)
  next_edit = {
    -- Optional: use a different model for next-edit
    -- model = "anthropic/claude-3-5-sonnet-20241022",
    -- Prompt type: "prefix_suffix" (default) or "line_number"
    prompt = "prefix_suffix",
  },
  inline_completion = {
    -- Optional: use a different model for inline completions
    -- model = "google/gemini-flash-latest",
  },
}
```

### Mode Configuration Details

#### `next_edit`

The `next_edit` mode generates code edits based on the full document context.

- **`model`** (optional): Override the global model for this mode
- **`prompt`** (optional): How the LLM receives file context
  - `"prefix_suffix"` (default): LLM receives compact hints with prefix/suffix anchoring. Use this when you want precise, localized edits.
  - `"line_number"`: LLM receives line numbers with full file content. Use this when you want the model to have better context or when prefix/suffix anchoring is unreliable.

#### `inline_completion`

The `inline_completion` mode generates completions at the cursor position. Currently uses a single implementation that receives text before and after the cursor.

- **`model`** (optional): Override the global model for this mode

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
          "text": "<multiline_edit>"
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

## Benchmarking

You can benchmark the `next_edit` generation with different models and
approaches:

```bash
# A/B test both approaches (default: prefix_suffix vs line_number)
bun run scripts/benchmark.ts --file test.ts --models openai/gpt-4

# Test a single approach
bun run scripts/benchmark.ts --file test.ts --models openai/gpt-4 \
  --approach prefix_suffix

# Test with diff preview and critic scoring
bun run scripts/benchmark.ts --file test.ts --models openai/gpt-4 \
  --approach both --preview --critic

# Export results to JSON for later analysis
bun run scripts/benchmark.ts --file test.ts --models openai/gpt-4 \
  --runs 10 --export-json results.json
```

### Benchmark Options

- `--file <path>` - input file to benchmark (required)
- `--models <m1,m2>` - comma-separated models to test (required)
- `--approach <prefix_suffix|line_number|both>` - approach to test (default: both)
- `--runs N` - number of runs per model/approach (default: 3)
- `--concurrency N` - parallel workers (default: 2)
- `--preview` - show colorized diffs of changes
- `--context N` - diff context lines (default: 3, only with --preview)
- `--no-color` - disable colored diff output
- `--critic` - enable critic scoring for quality assessment
- `--critic-model <model>` - model to use for critic (default: first model)
- `--export-json <path>` - export results to JSON file

### Post-Analysis

After running benchmarks with `--export-json`, you can analyze the results:

```bash
bun run scripts/analyze-ab-results.ts --results results.json
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
