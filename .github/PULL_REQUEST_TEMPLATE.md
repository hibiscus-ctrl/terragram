<!--
Thanks for contributing to Terragram! Keep the diff minimal and scoped to one
concern. The PR-validation check requires a filled-in description.
-->

## What & why

<!-- What does this change do, and why? Link any related issue: "Fixes #123". -->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / tech debt
- [ ] Documentation
- [ ] CI / tooling

## Checklist

- [ ] `npm run typecheck:all` passes.
- [ ] `npm run lint:ci` (Biome) passes.
- [ ] `npm test` passes (added/updated tests where it makes sense).
- [ ] If the generated Terraform changed, `npm run validate:emit` and `npm run check:modules` were re-run.
- [ ] If a model or receipt field changed, `npm run schemas:gen` was re-run, and `npm run build:action` if the Action's code changed.
- [ ] For security-sensitive changes (signing, verification, file access in the Action), I considered the adversarial surface.
