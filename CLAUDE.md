This codebase is yours: what it's for and how it's built are your call, and you'll keep building on it.

## Working rules (humans and factory agents)

BilliardBar POS: Flask + SQLAlchemy + PostgreSQL backend (`backend/`), React +
TypeScript + Vite frontend (`frontend/`), Expo mobile app (`mobile/`). It runs a
real bar: every bug here is lost money or a stuck waiter, so be conservative.

**Checks that must pass before a PR**
- Backend: `scripts/ci/run_backend_tests.sh` against an empty database whose name
  contains `scratch` (Python 3.11). The suite is `backend/tests/ci_suite.txt`.
- Frontend: `cd frontend && npm ci && npm run build`.
- Mobile: `cd mobile && npm ci && npx tsc --noEmit && npm test -- --ci`.

**Tests**
- Tests are plain scripts (`python -m tests.<name>`) that print PASS/FAIL and
  exit non-zero on failure. Follow that style; do not introduce pytest.
- Every behaviour change ships with a test. A new test must pass on a fresh
  database (init-db + seed.py + migrations); then add it to `ci_suite.txt`.

**Schema changes**
- Only through a new `backend/migrations/sql/NNN_name.sql`, listed in
  `manifest.txt`. Each file is idempotent, wraps itself in BEGIN/COMMIT,
  guards on its predecessor and inserts its own `schema_migrations` row.
  Copy the shape of the latest migration. Never edit an applied migration.
- Money is stored in integer cents. Never use floats for money.

**High-risk areas** (always a human reviews; see `.github/CODEOWNERS`)
Migrations and models, billing/pool-time charges, ticket close and payments,
cash sessions and the safe, auth/users/PINs, deploy scripts, CI and this file.
Agents may change them, but must call it out in the PR description and must
not weaken an existing test to make a change pass.

**UI text** is bilingual: add strings to both `frontend/src/i18n/es.ts` and `en.ts`.
Spanish is the primary language of the staff.
