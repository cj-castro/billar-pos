# Testing Patterns

**Analysis Date:** 2026-08-08

## Test Framework

**Runner:**
- No pytest, unittest, jest, or vitest is configured anywhere in the repo. There is no `pytest.ini`, `setup.cfg`, `pyproject.toml`, `conftest.py`, or `jest.config.*`/`vitest.config.*`.
- `backend/tests/` contains three **hand-rolled Python test scripts** that use plain `assert`-free `check(label, condition, detail)` helpers and a `main()` that aggregates pass/fail counts and sets the process exit code. They are executed directly as Python modules, not collected by a test runner.
- `frontend/` has **no test files at all** (no `*.test.tsx`, `*.spec.tsx`, or a testing library in `package.json` — no `@testing-library/react`, `vitest`, or `jest` dependency).
- `backend/verify_api2.py` and `backend/verify_confirm.py` are additional standalone HTTP-level verification scripts (not under `tests/`) that spin up a real Flask app against a live Postgres instance and hit real routes with `app.test_client()`.

**Assertion Library:** None — assertions are hand-implemented via a local `check(label, condition, detail='')` helper that appends `(label, bool(condition), detail)` to a `RESULTS`/`P/F` counter and prints `PASS`/`FAIL` lines. There is no `pytest.raises`, no `unittest.TestCase`, no `expect()`.

**Run Commands:**
```bash
# Pure-logic promotion engine tests (no DB required)
cd backend && python -m tests.test_promotions
cd backend && python -m tests.test_promo_time_window
cd backend && python -m tests.test_modifier_promotions

# HTTP-level verification against a live Postgres instance (DATABASE_URL
# hardcoded inside the script to postgresql://postgres:pos@localhost:55432/posverify)
cd backend && python verify_api2.py
cd backend && python verify_confirm.py
```
No `npm test` / `npm run test` script exists in `frontend/package.json` — only `dev`, `build`, `preview`.

## Test File Organization

**Location:**
- Backend logic tests: `backend/tests/` (a real Python package — has `__init__.py`).
- Backend HTTP verification scripts: repo root of `backend/` (`verify_api2.py`, `verify_confirm.py`) — siblings of `wsgi.py`, not inside `tests/`.
- No frontend test directory exists. If frontend tests are introduced, there is no established co-location or `__tests__/` convention to follow — establish one deliberately (e.g. co-located `*.test.tsx` next to source, consistent with the project's flat `components/`/`pages/`/`hooks/` layout).

**Naming:**
- Backend: `test_<feature>.py`, one file per behavioral concern — `test_promotions.py` (core BOGO/percent engine), `test_promo_time_window.py` (happy-hour time windows), `test_modifier_promotions.py` (modifier scaling + receipt grouping regressions).

**Structure:**
```
backend/
  tests/
    __init__.py
    test_promotions.py
    test_promo_time_window.py
    test_modifier_promotions.py
  verify_api2.py       # HTTP-level, needs live Postgres
  verify_confirm.py    # HTTP-level, needs live Postgres
```

## Test Structure

**Suite Organization (actual pattern from `backend/tests/test_promotions.py`):**
```python
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))  # make `app` importable

from app.services.promotion_svc import (
    PromoUnit, compute_quantity_promo_discounts, promo_is_in_date_range,
)

RESULTS = []

def check(label, condition, detail=''):
    RESULTS.append((label, bool(condition), detail))
    print(f'{"PASS" if condition else "FAIL"}  {label}' + (f'  -- {detail}' if detail else ''))

def test_bogo_two_buckets():
    d = compute_quantity_promo_discounts(bogo_2x1(), units(BUCKET, 2))
    check('1. 2x1: buy 2 buckets, pay 1', sum(d.values()) == PRICE,
          f'discount={sum(d.values())} expected={PRICE}')

def main():
    for fn in (test_bogo_two_buckets, test_percent_two_buckets, ...):
        fn()
    failed = [label for label, ok, _ in RESULTS if not ok]
    print(f'\n{len(RESULTS) - len(failed)}/{len(RESULTS)} checks passed')
    if failed:
        print('FAILED: ' + ', '.join(failed))
    return 1 if failed else 0

if __name__ == '__main__':
    sys.exit(main())
```
Functions named `test_*` are plain Python functions (not discovered by pytest — they are called explicitly by name inside `main()`). Each `test_*` function typically contains several numbered `check()` calls covering related sub-cases (e.g. `test_four_buckets` covers cases 3, 3b, 3c, 3d). Regression tests are named `test_regression_<bug description>` with a docstring explaining the historical defect being guarded against (see `test_regression_cheap_item_steals_promo`, `test_regression_category_scope_defaults_strict`).

**Patterns:**
- Setup: module-level constants for fixture data (`BUCKET = 'item-beer-bucket'`, `PRICE = 70000`) plus small factory functions (`bogo_2x1(**over)`, `qty_50_off(**over)`, `units(item_id, count, ...)`) that build fake domain objects with sensible defaults, overridable via `**over`/kwargs.
- Teardown: none needed — pure-function tests have no state to tear down. `verify_api2.py`/`verify_confirm.py` call `db.drop_all(); db.create_all()` at the start to reset a live test database instead of using fixtures/transactions-per-test.
- Assertion: every check is a single boolean expression passed to `check(label, condition, detail)`; `detail` is an f-string showing actual vs. expected values, always included when the check compares numeric results, omitted for simple boolean predicates.

## Mocking

**Framework:** None (no `unittest.mock`, `pytest-mock`, or `sinon`/`vitest.mock` equivalent found).

**Patterns:**
```python
# Stand-ins for SQLAlchemy models are plain Python classes with the same
# attribute surface as the real model — not a mocking library.
class FakePromo:
    """Stand-in for models.promotion.Promotion with the same attribute surface."""
    def __init__(self, **kw):
        self.id = kw.get('id', 'promo-1')
        self.promo_type = kw.get('promo_type', 'BOGO')
        ...
    def eligible_item_id_list(self):
        return list(self._eligible)
```
`test_modifier_promotions.py` loads the standalone Windows print-agent module directly from its file path via `importlib.util.spec_from_file_location` (it lives outside any package, at `scripts/print_agent/print_agent.py`) rather than mocking it — see `_load_print_agent()`.

**What to Mock:** Nothing is mocked with a mocking framework. Pure business logic (promotion engine, time-window math, print-agent formatting helpers) is tested by calling the real function with hand-built plain-Python fixture objects (`FakePromo`, `PromoUnit`, dict-shaped line items) that mirror the real model's public attribute/method surface.

**What NOT to Mock:** Database and HTTP layers are not mocked — when a test needs them (promo decision endpoint validation, CRUD), it uses a real Flask app + real Postgres via `app.test_client()` (`verify_api2.py`), not fakes.

## Fixtures and Factories

**Test Data:**
```python
def bogo_2x1(**over):
    cfg = dict(name='2x1 Cubetazo', promo_type='BOGO',
               applies_to_item_id=BUCKET, required_quantity=2, free_quantity=1)
    cfg.update(over)
    return FakePromo(**cfg)

def units(item_id, count, price=PRICE, line_item_id=None, already_discounted=False):
    return [PromoUnit(line_item_id or f'li-{item_id}-{i}', item_id, price, already_discounted)
            for i in range(count)]
```
Factory functions accept `**over`/keyword overrides on top of sensible defaults, so individual tests only specify what's different from the baseline case.

**Location:** Defined at the top of each test file, not shared across files — there is no shared `conftest.py` or `fixtures.py`. Duplication of `FakePromo` across `test_promotions.py` and `test_promo_time_window.py` is accepted (each file's `FakePromo` carries only the attributes relevant to that file's scenarios).

## Coverage

**Requirements:** None enforced. No coverage tool (`coverage.py`, `pytest-cov`, `c8`, `istanbul`) is configured.

**View Coverage:** Not applicable — there is no coverage tooling. Test completeness is tracked informally via the `PASS`/`FAIL` counts printed by each script's `main()`.

## Test Types

**Unit Tests:**
- `backend/tests/test_promotions.py` and `test_promo_time_window.py` test pure functions in `app/services/promotion_svc.py` with zero DB/HTTP dependency — these are the closest thing to true unit tests in the codebase.
- `backend/tests/test_modifier_promotions.py` unit-tests standalone formatting/grouping helpers in the print-agent script (`_group_modifiers`, `_group_line_items`) with dict-shaped fixtures mirroring `TicketLineItem.to_dict()` output.

**Integration Tests:**
- `backend/verify_api2.py` and `backend/verify_confirm.py` are full-stack integration checks: real Flask app (`create_app()`), real Postgres (`DATABASE_URL` pointed at a local `posverify` DB on port 55432), real JWT tokens (`create_access_token`), and `app.test_client()` HTTP calls against actual blueprint routes. They call `db.drop_all(); db.create_all()` to get a clean schema before seeding fixture rows (users, menu items, categories) directly via the ORM.
- No automated integration test for the frontend↔backend boundary exists.

**E2E Tests:** Not used. No Playwright/Cypress/Selenium config or dependency found anywhere in the repo.

## Common Patterns

**Async Testing:** Not applicable — all current tests are synchronous. The backend itself uses `eventlet`/`Flask-SocketIO` greenlets in production (`socketio.start_background_task`), but no test exercises that concurrency path.

**Error Testing:**
```python
# Negative/invalid-input cases are checked the same way as positive cases —
# by asserting the resulting dict/bool is empty/false, not via exception assertions:
check('4. 1 bucket + 1 nachos does not trigger the 2x1', d == {})
check('3a. no window at all -> always on',
      promo_time_window_contains(FakePromo(), local(2024, 6, 1, 3)))
```
There is no `pytest.raises`-style exception-assertion pattern in the test suite; when a function can raise (e.g. service-layer `ValueError` for `OUT_OF_STOCK`), it is exercised at the route/HTTP level in `verify_api2.py`/`verify_confirm.py` by checking the response status code and JSON `error` field returned by `app.test_client()`, not by asserting a raised exception directly.

## Adding New Tests

- For pure business logic (new promo types, billing calculations, time-window rules), follow `test_promotions.py`'s structure: add a new `backend/tests/test_<feature>.py`, define minimal `Fake*`/factory helpers at the top, write `test_*` functions using `check()`, and call every `test_*` function from `main()`. Add the run command as a module docstring (`cd backend && python -m tests.test_<feature>`).
- For anything requiring the database, JWT auth, or route-level validation, extend `verify_api2.py`/`verify_confirm.py` — do not invent a new fixture/mocking approach; these scripts already establish the "real Postgres + real Flask test client" pattern for that tier.
- There is no established frontend test tooling. If a phase requires frontend tests, a testing framework (Vitest is the natural fit given the Vite build) and its config must be introduced first — this is a gap, not an existing convention to match.

---

*Testing analysis: 2026-08-08*
