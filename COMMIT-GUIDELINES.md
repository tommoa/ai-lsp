# Commit Guidelines

This document outlines the commit message conventions used in this repository.

## Commit Message Format

All commit messages follow this structure:

```
<type>(<scope>): <brief description>

<body>
```

### Header

**Format:** `<type>(<scope>): <brief description>`

- **Type:** Indicates the kind of change
  - `feat`: New feature or capability
  - `fix`: Bug fix
  - `refactor`: Code restructuring without behavior change
  - `chore`: Maintenance tasks, dependency updates, configuration
  - `test`: Adding or updating tests
  - `docs`: Documentation changes

- **Scope:** Optional, indicates the area of the codebase (e.g., `inline`,
  `next-edit`, `benchmark`, `provider`, `parse`)

- **Brief description:**
  - Use lowercase
  - Start with a verb in imperative mood (e.g., "add", "fix", "refactor")
  - Be concise but descriptive
  - No period at the end

**Examples:**

- `feat(inline): add Fill-in-the-Middle support`
- `fix(benchmark): fix options parsing for benchmark-utils`
- `chore: replace CoreMessage with ModelMessage`

### Body

The commit body should explain the **why** and **context**, not just the what.

**Guidelines:**

1. **Start with context:** Explain the motivation or problem being solved
2. **Use imperative mood:** Describe what the code does, not what changed
   - ✅ "The function routes to Chat or FIM implementations"
   - ❌ "The function now routes to Chat or FIM implementations"
3. **Avoid temporal words:** Don't use "new", "now", "currently"
   - ✅ "A comprehensive test suite validates format detection"
   - ❌ "A new test suite now validates format detection"
4. **Use flowing paragraphs:** Prefer explanations over bullet points when
   possible
5. **Be specific:** Reference actual functions, modules, or patterns
6. **Include impact:** Explain how the change affects the system
7. **Optional sections:** Can include "Future improvements" or related notes

**Example body:**

```
Introduces FIM completion as an efficient alternative to chat-based prompts
for code-specific models. The modular structure separates FIM logic from
chat completion, enabling low-latency inline completions with specialized
models that support FIM formats.

The FIM module automatically detects the correct format for popular models
including CodeLlama, DeepSeek, StarCoder, and Qwen, while also supporting
custom format configuration. The generate() function routes to Chat or FIM
implementations based on a 'prompt' option, with graceful fallback handling
via UnsupportedPromptError for incompatible models.
```

## Common Patterns

### Feature commits

- Start with what the feature enables or provides
- Explain the technical approach
- Describe how components interact

### Fix commits

- Briefly state what was wrong
- Explain the impact of the bug
- Describe the solution

### Refactor commits

- Explain the motivation for restructuring
- Describe the structural changes
- Highlight benefits (maintainability, performance, etc.)

### Chore commits

- Can be brief if the change is self-explanatory
- Explain reasoning for dependency updates or config changes

## Writing Process

1. **Review the diff:** Understand all files changed
2. **Identify the core purpose:** What problem does this solve?
3. **Choose the right type and scope**
4. **Write the header:** Concise, imperative, lowercase
5. **Draft the body:**
   - Start with "why" and context
   - Explain the approach
   - Describe the impact
6. **Review for style:**
   - Remove temporal words (now, new, currently)
   - Use imperative mood consistently
   - Keep it concise but complete

## See Also

Review recent commits with `git log --pretty=format:"%h %s%n%b%n---" -10` to
see examples of the commit style in practice.
