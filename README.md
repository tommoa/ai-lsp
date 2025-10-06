# ai-lsp

This project aims to copy the functionality of `copilot-language-server`, but providing some additional flexibility.

NOTE: This is currently very WIP.

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init`. [Bun](https://bun.sh) is a fast all-in-one JavaScript runtime.

## FAQ

### Why is this written in TypeScript?

I actually prefer writing things in Rust and C++, so those would have been more
natural languages for me to pick. But there are a couple of reasons why this
ended up being written in TypeScript.

1. I wanted to learn TypeScript - all of my normal work is in more low-level
   languages.
2. It seems (to me) to be relatively easy to arbitrarily import modules, which
   is helpful in the fast-moving AI space.
