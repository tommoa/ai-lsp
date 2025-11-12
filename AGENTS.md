**Agent Guidelines**

- **Build & Run:** Install: `bun install`; Run: `bun run src/index.ts`
- **Type-check:** `bunx tsc --noEmit`
- **Run tests:** `bun test` (all) — single test: `bun test path/to/testfile`
  - Unit tests: `bun test tests/*.test.ts`
  - E2E tests: `bun test tests/e2e/**/*.test.ts`
  - Benchmark tests: `bun test tests/benchmark-*.test.ts`

- **Lint & Format:** `bun run lint` (check); `bun run lint:fix` (autofix); `bun run format` (Prettier)
- **Line length:** keep lines <= 80 characters (enforced by ESLint)

- **Imports & Modules:** Use ESM imports/exports; use `import type` for types-only
- **Import order:** external deps, blank line, then internal modules

- **Types & Naming:** explicit types on public APIs; avoid `any`
- **Conventions:** `camelCase` for vars/functions, `PascalCase` for types/classes, `UPPER_SNAKE` for constants

- **Formatting & Errors:** run Prettier/ESLint autofix before commits; throw or return errors; do not swallow
- **Error messages:** use descriptive messages and avoid including secrets

- **Agent checks:** run `bunx tsc --noEmit`, `bun run lint` and `bun run src/index.ts` to validate changes
- **Cursor/Copilot:** follow any `.cursor` rules and `.github/copilot-instructions.md` if present

- **Commits:** follow the style guide in `COMMIT-GUIDELINES.md`
  - NEVER make a commit without explicit permission from the user
