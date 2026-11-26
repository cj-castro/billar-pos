# Software Factory

Issues go in; tested, reviewed PRs come out. Built in stages so each one is
trusted before the next is added.

| Stage | What | Status |
|---|---|---|
| 0 | CI on every PR: backend tests on a fresh Postgres, frontend build, mobile tests | ✅ this PR |
| 1 | **Developer agent**: label an issue `factory` → Claude opens a PR. `@claude` in comments for follow-ups | ✅ this PR |
| 1 | **Human gate**: CODEOWNERS on money/cash/auth/schema paths | ✅ this PR |
| 2 | **4 parallel reviewers** (security, UX, design, code quality) on a different model than the developer, each posting a pass/fail verdict | next |
| 3 | **Quality gate**: any fail → feedback to the developer, max 3 rounds, then a human | next |
| 4 | **Analyst + architect** in front: triage the issue, write `specs/<issue>.md` before coding | later |
| 5 | **Auto-merge** low-risk PRs (no CODEOWNERS paths, all checks + reviewers green) | later |

## One-time setup (repo owner)

1. **Secret**: Settings → Secrets and variables → Actions → `ANTHROPIC_API_KEY`
   (or use a Claude subscription token, see `.github/workflows/factory.yml`).
2. **Claude GitHub App**: install it on this repo: https://github.com/apps/claude
3. **Label**: create an issue label named `factory`.
4. **Branch protection on `main`**: require a pull request; require the
   `backend`, `frontend` and `mobile` checks; require review from Code Owners.

## How to use it

Write an issue the way you would brief a new developer: what is wrong or
wanted, where in the app, and how to tell it is done. Then add the `factory`
label. Watch the Actions tab; a PR appears when the agent is finished. Review
it, ask for changes with `@claude ...` on the PR, merge when happy.

## Known gap: test data

16 of the 25 backend test modules look up real Bola 8 menu/inventory items by
name or need a live server, so they cannot run in CI yet. Building a sanitized
fixture dataset (a good first `factory` issue) unlocks them, and makes every
later stage more trustworthy: the reviewers and gates are only as good as the tests.
