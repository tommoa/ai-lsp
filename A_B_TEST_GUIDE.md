# A/B Testing Guide: Line Numbers vs Prefix/Suffix Anchoring

This guide explains how to run and analyze A/B tests comparing the two LLM hint approaches.

## Overview

The project now includes two variants for generating code edits from LLM suggestions:

1. **Baseline** (`src/next-edit.ts`): Uses prefix/suffix string anchoring
   - LLM receives: full file content
   - LLM returns: `{prefix, existing, suffix, text, reason}`
   - Conversion: String matching with 4 fallback strategies
   - Pros: More context-aware, handles repeated patterns better
   - Cons: Complex string matching, potentially higher token usage

2. **LineNum** (`src/next-edit-linenum.ts`): Uses line-number ranges
   - LLM receives: line-numbered file content (L1:, L2:, ...)
   - LLM returns: `{startLine, endLine, text, reason}`
   - Conversion: Direct line-to-position mapping
   - Pros: Simpler format, potentially fewer tokens
   - Cons: Less contextual info, may struggle with duplicate lines

## Setup

### Prerequisites

- Bun >= 1.2.13
- API credentials for your LLM provider (Claude, OpenAI, etc.)
- Test file(s) to benchmark

### Test Fixtures

Sample test files are provided in `tests/fixtures/`:

```
tests/fixtures/
├── small/           # < 50 lines (simple refactoring)
│   ├── simple-refactor.ts
│   ├── bug-fix.py
│   └── formatting.js
├── medium/          # 50-200 lines (multi-location edits)
│   ├── multi-edit.ts
│   └── duplicate-code.py
├── large/           # 200+ lines (performance testing)
│   └── complex-file.ts
└── edge/            # Edge cases
    ├── all-duplicates.txt
    ├── single-line.js
    └── empty.txt
```

## Running Tests

### Basic Usage

Compare both approaches on a single file:

```bash
bun run scripts/benchmark-next-edit-ab.ts \
  --file tests/fixtures/small/simple-refactor.ts \
  --models anthropic/claude-3-5-sonnet-20241022 \
  --runs 3 \
  --approach both
```

### Command Options

| Option             | Description                                | Default     |
| ------------------ | ------------------------------------------ | ----------- |
| `--file`           | Path to test file (required)               | -           |
| `--models`         | Comma-separated model list (required)      | -           |
| `--approach`       | `baseline`, `linenum`, or `both`           | `both`      |
| `--runs`           | Number of test runs per approach           | 3           |
| `--concurrency`    | Parallel workers per approach              | 2           |
| `--critic-model`   | Model for quality scoring                  | First model |
| `--critic-retries` | Retries for critic scoring                 | 1           |
| `--price-per-1k`   | Cost per 1000 tokens (for budget tracking) | null        |

### Example: Multi-Model Comparison

```bash
bun run scripts/benchmark-next-edit-ab.ts \
  --file tests/fixtures/medium/multi-edit.ts \
  --models anthropic/claude-3-5-sonnet,openai/gpt-4o \
  --runs 5 \
  --concurrency 3 \
  --critic-model anthropic/claude-3-5-sonnet-20241022 \
  --price-per-1k 0.03
```

### Example: Cost-Tracking Run

```bash
bun run scripts/benchmark-next-edit-ab.ts \
  --file tests/fixtures/large/complex-file.ts \
  --models anthropic/claude-3-5-sonnet-20241022 \
  --runs 10 \
  --approach both \
  --price-per-1k 0.03
```

## Understanding Output

The benchmark produces real-time output and a final comparison table:

```
=== Benchmarking baseline (runs=3, concurrency=2) ===
baseline run 1/3...
baseline generation latency=1245ms
baseline generation tokens=1523
baseline score= 87.5
baseline critic latency=1890ms
...

=== Benchmarking linenum (runs=3, concurrency=2) ===
linenum run 1/3...
linenum generation latency=1089ms
linenum generation tokens=1401
linenum score= 85.2
...

============================================================
COMPARISON TABLE
============================================================
Metric | Baseline | LineNum | Winner
---------------------------------------------------------------------------
Quality Score | 87.50 | 85.20 | Baseline
Gen Latency (ms) | 1245 | 1089 | LineNum
Gen Tokens | 1523 | 1401 | LineNum
Gen Cost ($) | 0.046 | 0.042 | LineNum
Success Rate | 100.00 | 100.00 | -
```

## Analysis Script

Export results to JSON and run statistical analysis:

```bash
# Save benchmark results to JSON
bun run scripts/benchmark-next-edit-ab.ts \
  --file tests/fixtures/small/simple-refactor.ts \
  --models anthropic/claude-3-5-sonnet-20241022 \
  --runs 5 \
  --approach both > results.json 2>&1

# Run statistical analysis
bun run scripts/analyze-ab-results.ts --results results.json
```

The analysis script performs:

- Mean, median, std dev calculations
- Welch's t-tests for statistical significance
- Cost/performance comparisons
- Winner determination

## Unit Tests

All components have unit tests:

```bash
# Test line-number variant
bun test tests/next-edit-linenum.test.ts

# Run all tests
bun test
```

## Implementation Details

### Line-Number Format

The `LineNum` variant prefixes each line with `L<number>:`:

```
L1: function add(a, b) {
L2:   return a + b;
L3: }
```

This makes line numbers explicit and unambiguous.

### Conversion Logic

**Baseline** (string matching with fallbacks):

1. Try exact anchor match: `prefix + existing + suffix`
2. Try unique prefix + existing
3. Try insertion after unique prefix
4. Try unique existing string

**LineNum** (direct line mapping):

1. Validate 1-based line numbers are within document
2. Convert to 0-based indices
3. Calculate character offsets via line breaks
4. Create LSP Range from positions

The baseline approach is more flexible but requires complex string matching.
The linenum approach is more direct but less tolerant of ambiguity.

## Test Scenarios

The test fixtures cover:

### Small Files (Simple Refactoring)

- Variable renaming
- Spacing/formatting fixes
- Single-location edits
- Quick response validation

### Medium Files (Multi-Location Edits)

- Type system changes
- Multi-function refactoring
- Validation logic fixes
- Complex edits

### Large Files (Performance)

- Complex class/object structures
- Many methods/functions
- Higher token usage
- Latency and cost tracking

### Edge Cases

- All duplicate lines (ambiguity test)
- Single line files (minimal context)
- Empty files (error handling)
- Whitespace-only content

## Interpreting Results

### Quality Score

Higher is better. Measures overall correctness and usefulness of generated edits.

### Generation Latency

Time to generate edits. Lower is better for user experience.
Note: Influenced by model complexity and may vary by provider.

### Token Usage

Input + output tokens. Lower is better for cost efficiency.
LineNum typically uses fewer tokens due to simpler format.

### Success Rate

Percentage of runs where edits were successfully generated and applied.
Should be > 95% for both approaches.

## Trade-offs Analysis

| Factor               | Baseline                  | LineNum                     |
| -------------------- | ------------------------- | --------------------------- |
| **Context**          | More (prefix+suffix)      | Less (line numbers only)    |
| **Complexity**       | Higher (string matching)  | Lower (line mapping)        |
| **Token Efficiency** | Baseline                  | ~10-15% lower               |
| **Robustness**       | Better for ambiguous code | Better for clear structures |
| **Error Handling**   | 4 fallback strategies     | 1 validation check          |
| **Speed**            | Slower (string search)    | Faster (direct mapping)     |

## Decision Framework

Choose **Baseline** if:

- Your codebase has many duplicate or similar blocks
- Quality is more important than cost
- You want maximum flexibility in matching

Choose **LineNum** if:

- Cost efficiency is critical
- Code is well-structured (few duplicates)
- Speed is important
- You want simpler prompts and reasoning

## Next Steps

1. **Run baseline tests** on your codebase

   ```bash
   bun run scripts/benchmark-next-edit-ab.ts \
     --file <your-file> \
     --models <your-model> \
     --approach baseline \
     --runs 5
   ```

2. **Run linenum tests** on same file

   ```bash
   bun run scripts/benchmark-next-edit-ab.ts \
     --file <your-file> \
     --models <your-model> \
     --approach linenum \
     --runs 5
   ```

3. **Analyze results**

   ```bash
   bun run scripts/analyze-ab-results.ts --results results.json
   ```

4. **Make decision** based on:
   - Quality scores
   - Token usage vs cost
   - Latency requirements
   - Your specific use case

## Troubleshooting

### "File not found"

Check the file path is absolute or relative from project root.

### "No model provided"

Ensure `--models` is set and API credentials are configured.

### "LLM generation failed"

- Check API credentials
- Verify model name is correct
- Check token limits
- Review LLM response format

### "Parsing failed"

- LLM response may not be JSON
- Check prompt expectations
- Review LLM output in logs

### Tests pass but edits don't apply

- Line numbers may be invalid
- Character offset calculation issues
- Document encoding problems (CRLF vs LF)

## Contributing

To add new test fixtures:

1. Create file in `tests/fixtures/<category>/`
2. Keep files < 300 lines for speed
3. Ensure files have real refactoring opportunities
4. Document the intended edits as comments
