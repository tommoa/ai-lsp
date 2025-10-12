**Agent Guidelines**

- **Build & Run:** Install: `bun install`; Run: `bun run index.ts`
- **Type-check:** `bunx tsc --noEmit`
- **Run tests:** `bun test` (all) — single test: `bun test path/to/testfile` or `node --test path/to/testfile`

- **Lint & Format:** `bun run lint`; `bun run format`
- **Line length:** keep lines <= 80 characters

- **Imports & Modules:** Use ESM imports/exports; use `import type` for types-only
- **Import order:** external deps, blank line, then internal modules

- **Types & Naming:** explicit types on public APIs; avoid `any`
- **Conventions:** `camelCase` for vars/functions, `PascalCase` for types/classes, `UPPER_SNAKE` for constants

- **Formatting & Errors:** run Prettier/ESLint autofix before commits; throw or return errors; do not swallow
- **Error messages:** use descriptive messages and avoid including secrets

- **Agent checks:** run `bun tsc --noEmit`, `bun run lint` and `bun run index.ts` to validate changes
- **Cursor/Copilot:** follow any `.cursor` rules and `.github/copilot-instructions.md` if present
