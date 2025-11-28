# ai-lsp

An LSP server providing AI-powered code completion and editing with flexible
model provider support. This project aims for API compatibility with
`copilot-language-server`, allowing it to work as a drop-in replacement while
providing flexibility in model provider choice. Supports multiple AI providers
(Google, Anthropic, OpenAI, Ollama, LM Studio) for both inline completions and
next-edit suggestions.

## API Compatibility with copilot-language-server

ai-lsp implements the same LSP endpoints as `copilot-language-server`:

**Implemented:**

- `textDocument/completion` - Inline completions at cursor position (maps to
  copilot's `textDocument/inlineCompletion`)
- `textDocument/copilotInlineEdit` - Next-edit suggestions for larger
  multi-line edits
- Configuration via `initializationOptions`

**Not yet implemented:**

- `textDocument/didFocus` - Document focus notifications
- `textDocument/didShowCompletion` - Telemetry when completions are shown
- `textDocument/didPartiallyAcceptCompletion` - Telemetry for partial accepts

See [docs/json-rpc.md](docs/json-rpc.md) for detailed API documentation.

## Features

- **Inline Completion**: AI-powered code completions at cursor position
  - Chat-based completion (default)
  - Fill-in-the-Middle (FIM) format for efficient code completion
- **Next Edit**: Context-aware code edits based on full document context
  - Prefix/suffix anchoring for precise, localized edits
  - Line number context for better file understanding
- **Multiple Providers**: Google, Anthropic, OpenAI, Ollama, LM Studio, and
  OpenAI-compatible APIs
- **Flexible Configuration**: Per-mode model and prompt customization
- **Benchmarking**: [Compare models and strategies](#benchmarking) to evaluate
  performance on your codebase

## Installation

To install dependencies:

```bash
bun install
```

## Running the LSP Server

To run the LSP server:

```bash
bun start
```

Or directly:

```bash
bun run src/index.ts
```

## Configuration

The LSP server is configured via `initializationOptions` with the following
structure:

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
    -- Prompt type: "prefix-suffix" (default) or "line-number"
    prompt = "prefix-suffix",
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
  - `"prefix-suffix"` (default): LLM receives compact hints with prefix/suffix anchoring. Use this when you want precise, localized edits.
  - `"line-number"`: LLM receives line numbers with full file content. Use this when you want the model to have better context or when prefix/suffix anchoring is unreliable.

#### `inline_completion`

The `inline_completion` mode generates completions at the cursor position. It can use either Fill-in-the-Middle (FIM) format for efficient code completion or chat-based completion.

- **`model`** (optional): Override the global model for this mode
- **`prompt`** (optional): How completions are generated
  - `"chat"` (default): Use chat-based completion (works with any model)
  - `"fim"`: Use Fill-in-the-Middle format (requires FIM-capable models)

  **Note:** Not all model variants support FIM. Base/pretrained models typically
  support FIM (e.g., `qwen2.5-coder:3b-base`, `codellama:7b-code`), while
  instruction-tuned variants often don't (e.g., `qwen2.5-coder:3b`,
  `codellama:7b-instruct`). If you encounter errors with FIM, try using the
  base model variant or switch to `"chat"` mode.

- **`fim_format`** (optional): FIM template to use when `prompt = "fim"`
  - Can be a template name: `"openai"`, `"starcoder"`, `"codellama"`,
    `"deepseek"`, or `"qwen"`
  - Can be a custom template object with `prefix`, `middle`, and `suffix` tokens
  - If not specified, the format will be auto-detected from the model name
  - If auto-detection fails, defaults to OpenAI format

### Using Local Providers

ai-lsp supports local model providers like **Ollama** and **LM Studio** out of the box.

#### Ollama

1. Start Ollama:

   ```bash
   ollama serve
   ```

2. Pull a code model:

   ```bash
   ollama pull <model-name>
   ```

3. Configure in your LSP client (example: `examples/ollama-init.lua`):
   ```lua
   init_options = {
     providers = {
       ollama = {
         -- Optional: override default endpoint
         baseURL = "http://localhost:11434/v1",
       },
     },
     model = "ollama/<model-name>",
     inline_completion = {
       prompt = "chat",  -- or "fim" if your model supports it
     },
   }
   ```

**FIM Support by Model Variant:**

Not all model variants support FIM. Typically, base/pretrained models support FIM
while instruction-tuned variants often don't.

Base/pretrained models that support FIM:

- `codellama:7b-code`
- `deepseek-coder:6.7b-base`
- `qwen2.5-coder:3b-base`

Instruction-tuned variants that typically don't support FIM:

- `codellama:7b-instruct`
- `deepseek-coder:6.7b-instruct`
- `qwen2.5-coder:3b`

If a model doesn't support FIM, the server will automatically fall back to
chat-based completion, or you can explicitly set `prompt = "chat"` in your
configuration.

#### LM Studio

LM Studio works the same way as Ollama:

```lua
init_options = {
  providers = {
    lmstudio = {
      baseURL = "http://localhost:1234/v1",  -- LM Studio default port
    },
  },
  model = "lmstudio/<model-name>",
  inline_completion = {
    prompt = "chat",  -- or "fim" if your model supports it
  },
}
```

**Note:** Model names in LM Studio may vary depending on how you've loaded them.
Check the LM Studio UI for the exact model identifier.

### FIM Format Configuration

The `fim_format` option in `inline_completion` allows you to specify which
Fill-in-the-Middle (FIM) format template to use. This is useful when
auto-detection doesn't work or when you want to use a custom format.

#### Explicit Template Names

```lua
init_options = {
  model = "ollama/codellama",
  inline_completion = {
    prompt = "fim",
    -- Explicitly specify the CodeLlama format
    fim_format = "codellama",
  },
}
```

#### Auto-Detection (Default)

If `fim_format` is not specified, the system will auto-detect based on the
model name:

- Models with `codellama` → CodeLlama format
- Models with `deepseek` → DeepSeek format
- Models with `qwen` → Qwen format
- Models with `starcoder` → StarCoder format
- Everything else → OpenAI format (default)

```lua
init_options = {
  model = "ollama/codegemma",
  inline_completion = {
    prompt = "fim",
    -- No fim_format specified - will auto-detect or default to OpenAI
  },
}
```

#### Custom Template

For models with non-standard FIM formats, you can define a custom template:

```lua
init_options = {
  model = "custom-provider/custom-model",
  inline_completion = {
    prompt = "fim",
    fim_format = {
      prefix = "<|im_start|>user\n",
      middle = "<|im_start|>assistant\n",
      suffix = "<|im_end|>",
    },
  },
}
```

## Benchmarking

ai-lsp includes comprehensive benchmarking tools to compare models, prompt
strategies, and measure performance metrics.

### Next-Edit Benchmarking

Benchmark `next_edit` generation to compare models and prompt strategies
(prefix/suffix vs line-number).

#### Basic Usage

```bash
# Test both prompt strategies
bun run scripts/benchmark.ts \
  --file tests/fixtures/small/simple-refactor.ts \
  --models google/gemini-flash-latest

# Test a specific strategy
bun run scripts/benchmark.ts \
  --file tests/fixtures/small/simple-refactor.ts \
  --models google/gemini-flash-latest \
  --approach prefix-suffix

# Compare multiple models
bun run scripts/benchmark.ts \
  --file tests/fixtures/small/simple-refactor.ts \
  --models google/gemini-flash-latest,anthropic/claude-3-5-sonnet-20241022 \
  --approach both
```

#### Advanced Usage

```bash
# Show colorized diffs with critic scoring
bun run scripts/benchmark.ts \
  --file tests/fixtures/small/simple-refactor.ts \
  --models google/gemini-flash-latest \
  --approach both \
  --preview --critic

# Export results for analysis
bun run scripts/benchmark.ts \
  --file tests/fixtures/small/simple-refactor.ts \
  --models google/gemini-flash-latest \
  --runs 10 \
  --export-json next-edit-results.json
```

#### Options

- `--file <path>` - Input file to benchmark (required)
- `--models <m1,m2>` - Comma-separated models to test (required)
- `--approach <prefix-suffix|line-number|both>` - Prompt strategy (default:
  both)
- `--runs N` - Number of runs per model/approach (default: 3)
- `--concurrency N` - Parallel workers (default: 2)
- `--preview` - Show colorized diffs of changes
- `--context N` - Diff context lines (default: 3, only with --preview)
- `--no-color` - Disable colored diff output
- `--critic` - Enable critic scoring for quality assessment
- `--critic-model <model>` - Model to use for critic (default: first model)
- `--export-json <path>` - Export results to JSON file

### Inline Completion Benchmarking

Benchmark inline completions to compare models and completion strategies
(chat vs FIM).

#### Basic Usage

```bash
# Test both completion strategies
bun run scripts/inline-benchmark.ts \
  --test-cases tests/fixtures/inline-completion-cases.json \
  --models google/gemini-flash-latest

# Test a specific strategy
bun run scripts/inline-benchmark.ts \
  --test-cases tests/fixtures/inline-completion-cases.json \
  --models ollama/codegemma \
  --approach fim

# Compare multiple models
bun run scripts/inline-benchmark.ts \
  --test-cases tests/fixtures/inline-completion-cases.json \
  --models ollama/codegemma,google/gemini-flash-latest \
  --approach all
```

#### Advanced Usage

```bash
# Show completion previews with critic scoring
bun run scripts/inline-benchmark.ts \
  --test-cases tests/fixtures/inline-completion-cases.json \
  --models google/gemini-flash-latest \
  --approach all \
  --preview --critic

# Export results for analysis
bun run scripts/inline-benchmark.ts \
  --test-cases tests/fixtures/inline-completion-cases.json \
  --models ollama/codegemma \
  --runs 10 \
  --export-json inline-results.json
```

#### Options

- `--test-cases <path>` - JSON file with test cases (required)
- `--models <m1,m2>` - Comma-separated models to test (required)
- `--approach <chat|fim|all>` - Completion strategy (default: all)
- `--runs N` - Number of runs per model/approach (default: 3)
- `--concurrency N` - Parallel workers (default: 2)
- `--preview` - Show completion previews
- `--no-color` - Disable colored output
- `--critic` - Enable critic scoring for quality assessment
- `--critic-model <model>` - Model to use for critic (default: first model)
- `--export-json <path>` - Export results to JSON file

### Using Local Models

Both benchmark scripts support local providers like Ollama and LM Studio:

```bash
# Next-edit with Ollama
bun run scripts/benchmark.ts \
  --file tests/fixtures/small/simple-refactor.ts \
  --models ollama/codegemma \
  --runs 3

# Inline completion with Ollama (FIM)
bun run scripts/inline-benchmark.ts \
  --test-cases tests/fixtures/inline-completion-cases.json \
  --models ollama/codegemma \
  --approach fim \
  --runs 5
```

**Note:** Provider configuration (baseURL, apiKey) currently works through LSP
`initializationOptions` only. CLI flags for provider config will be added in a
future update.

### Analyzing Results

After running benchmarks with `--export-json`, analyze the results:

```bash
bun run scripts/analyze-ab-results.ts --results results.json
```

This provides statistical analysis including:

- Latency metrics (mean, median, p95)
- Token usage and costs
- Quality scores (if critic enabled)
- Side-by-side comparison tables

## Development

### Available Scripts

- `bun start` or `bun run src/index.ts` - Run the LSP server
- `bun test` - Run all tests
- `bun test tests/*.test.ts` - Run unit tests
- `bun test tests/e2e/**/*.test.ts` - Run end-to-end tests
- `bun test tests/benchmark-*.test.ts` - Run benchmark tests
- `bun run lint` - Check code style
- `bun run lint:fix` - Auto-fix linting issues
- `bun run format` - Format code with Prettier
- `bunx tsc --noEmit` - Type-check code

### Type Checking

To verify TypeScript types:

```bash
bunx tsc --noEmit
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
