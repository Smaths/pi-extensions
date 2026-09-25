# Agent guidance

- This repo contains **independently installable Pi extensions**, one per top-level directory; it is not a combined package.
- Each extension should keep `index.ts`, `package.json`, and a concise `README.md` together. Use TypeScript ESM, tabs, double quotes, and semicolons to match the existing code.
- Keep Herdr integrations opt-in and avoid duplicating integrations managed by Herdr.
- For every extension, use a stable kebab-case name and add `img/<extension-name>.png`; update the root `README.md` with a one-sentence description and screenshot.
- Use `./link-extensions.sh` for local linking. Publish and version packages independently; do not commit dependencies, builds, caches, or local environment files.
- Before committing, run `git diff --check` and manually verify the extension in Pi when practical.
