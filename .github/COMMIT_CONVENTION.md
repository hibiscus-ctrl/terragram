# Commit convention

Commit messages here follow **Conventional Commits 1.0.0**. Describe only what
the staged diff actually changes.

This file is the single source of truth for commit style in this repository. It
is written for humans and for coding agents alike — if you change the rules,
change them here.

## Format

```
type(scope): description

body

footers
```

- **Subject** — `type(scope): description`, max 72 characters.
  - Imperative mood: "add", "fix", "rename" — never "added", "adds", "adding".
  - Lowercase first word, no trailing full stop.
  - It must summarise the change as a whole, in one line. Never put a list of
    changes in the subject; that belongs in the body.
- **Blank line** between subject and body. Always.
- **Body** — wrap at 72 columns. Required for anything beyond a trivial change.
- **Footers** — `BREAKING CHANGE: <what breaks and what to do>`, `Closes #123`,
  `Refs #123`.

Breaking changes take `!` before the colon (`feat(api)!: …`) **and** a
`BREAKING CHANGE:` footer.

## Choosing the type

Pick the type from the **effect of the change**, not from how large the diff is
or which files it touches.

| Type | Use when | Do NOT use when |
|---|---|---|
| `feat` | Users can do something they could not do before | Existing behaviour is merely improved, tidied or corrected |
| `fix` | Behaviour was wrong and is now correct | Nothing was broken — that is `refactor` or `perf` |
| `refactor` | Code structure changed, observable behaviour did not | Behaviour changed at all |
| `perf` | Change is specifically about speed or resource use | |
| `docs` | Documentation, comments, `CLAUDE.md`/`AGENTS.md`, docs pages | Code changes ship alongside — pick the code's type |
| `style` | Formatting, naming, whitespace; no logic change | |
| `test` | Tests added or changed and nothing else | Production code changed too |
| `build` | Dependencies, Docker, bundling, `package.json` | |
| `ci` | Workflows under `.github/workflows`, CI scripts | |
| `chore` | Housekeeping that fits nothing above | You are unsure — work out the real type instead |
| `revert` | Reverting a previous commit; name it in the body | |

If the description you write contains a different verb from the type you chose
("fix: refactor the billing logic"), the type is wrong. Fix the type.

**These repositories have historically labelled almost everything `feat`.** Do
not continue that. Before writing `feat`, check that a user really can do
something they could not do before; most of what looks like a feature is
`refactor`, `fix`, `build` or `chore`.

## Scopes

One scope, lowercase. Prefer a scope already used in this repository — the list
is in **This repository** at the end of this file. Omit the scope when the
change is genuinely cross-cutting. Do not invent a new scope for a one-off; use
the closest existing one, or none.

## Body

Explain **why**, and anything a reviewer could not infer from the diff:

- The problem or user-visible symptom that prompted the change.
- The approach taken, and any alternative rejected, when it is not obvious.
- Consequences: migrations needed, config or env vars required, follow-up work.
- Trade-offs and known limitations.

Do not narrate the diff file by file, and do not restate the subject. "Updated
X to do Y" for every changed file adds nothing a reader cannot see. Bullets are
fine for genuinely independent changes, but prose is better for one change with
a reason behind it.

If the staged changes cover unrelated concerns, say so plainly at the end of the
body rather than inventing a single theme — and mention that they would be
better as separate commits.

## Accuracy

- Describe only what is in the staged diff. Never claim a fix, test or migration
  that is not there.
- Do not guess at motivation. If the reason is not evident from the diff,
  describe the change precisely and leave the reason out.
- Do not describe generated files as hand-written work.

## House style

- No emoji and no gitmoji. Older commits carry `:sparkles:` and `:art:`; that
  convention is retired.
- No "WIP", and never a ticket number alone as a subject.
- Do not mention Copilot, Claude, AI assistance, or the tooling used to write
  the code. No `Co-Authored-By` trailer for an assistant.

## Examples

Good:

```
fix(guardrails): confine emit-tool output paths to the workspace

terraform_emit_sarif accepted any path the agent supplied, so a
prompt-injected agent had an arbitrary file write on the runner.
Output paths now go through resolveWithinCwd, which also follows
symlinks — the workspace is the PR's checkout, so a committed symlink
is attacker-controlled input, not an edge case.
```

```
feat(mcp)!: require a selected mode before checkout_pr

Runs that skipped select_mode checked out PRs with no write policy
published, so write-time gating silently never engaged. checkout_pr now
refuses until a mode is selected.

BREAKING CHANGE: workflows that call checkout_pr before select_mode must
reorder the two calls.
```

Bad — and why:

- `feat: enhance guardrails and update dependencies - Added X - Updated Y -
  Revised Z` — a changelog in the subject line, and `feat` for work that is
  mostly refactoring.
- `fix: refactor token handling logic` — the type says fix, the description
  says refactor. One of them is wrong.
- `refactor: refactor scanner gates and error handling` — repeats the type and
  names no actual change.

## Writing one with an agent

Stage your changes, then run `/commit-message` in Claude Code. It reads this
file, inspects `git diff --cached`, and returns a paste-ready message.

## This repository

**Types do not cut releases here** — this repo has no release-please setup and
is deployed, not published. Pick the type accurately anyway: it is what makes
`git log` and `git blame` readable, and it is the only signal of intent a
reviewer gets before opening the diff.

**Scopes in use:** `account`, `api`, `app`, `auth`, `billing`, `deps`, `docs`,
`git`, `marketing`, `scim`, `security`, `ui`, `workspace`

**Call these out in the body when the diff touches them:**

- **Supabase migrations.** The project is shared: say whether the migration has
  been applied, to which environment, and whether it is reversible. The
  migration here owns only `terragram_*` objects.
- **Generated Terraform.** A change to what the workspace emits should say
  whether `npm run validate:emit` and `npm run check:modules` were re-run.
