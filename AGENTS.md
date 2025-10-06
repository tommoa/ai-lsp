**Build & Run**

- Install: `bun install`
- Run: `bun run index.ts` (entrypoint `index.ts`)
- Type-check: `npx tsc --noEmit` (or `bunx tsc --noEmit`)
- Run single test: `bun test path/to/testfile` (preferred) or `node --test path/to/testfile`

**Lint & Format**

- Lint: `npx eslint . --ext .ts` (use `--fix`)
- Format: `npx prettier --write .`
- Use a maximum line length of 80 characters.

**Imports & Modules**

- Use ESM imports/exports; use `import type` for types-only imports.
- Group imports: external deps first, blank line, then internal modules.

**Types & Naming**

- Prefer explicit types on public APIs; avoid `any`.
- Use `camelCase` for vars/functions, `PascalCase` for types/classes, `UPPER_SNAKE` for constants.

**Formatting & Error Handling**

- Run Prettier/ESLint autofix before commits; keep lines <= 80 chars.
- Throw or return errors; do not swallow. Use descriptive messages and avoid secrets.

**Agent rules**

- If present, follow `.cursor` rules and `.github/copilot-instructions.md`.
- Agents should run `npx tsc --noEmit` and `bun run index.ts` to validate changes.
