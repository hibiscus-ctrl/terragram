<!--
Thanks for contributing to Terragram Cloud! Keep the diff minimal and scoped to one
concern. The PR-validation check requires a filled-in description.
-->

## What & why

<!-- What does this change do, and why? Link any related issue: "Fixes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] UI / UX
- [ ] Refactor / tech debt
- [ ] Documentation
- [ ] CI / tooling

## Screenshots

<!-- For any UI change, include before/after screenshots (light mode). Delete if N/A. -->

## Checklist

- [ ] `npx tsc --noEmit` passes.
- [ ] `npm run lint` (Biome) passes.
- [ ] `npm test` passes (added/updated tests where it makes sense).
- [ ] Request bodies at new/changed API routes are validated with a Zod schema via `parseBody`.
- [ ] DB changes go in the single consolidated `database.sql` (no separate migration files).
- [ ] For security-sensitive changes (auth, tokens, RLS, webhooks), I considered the adversarial surface.
