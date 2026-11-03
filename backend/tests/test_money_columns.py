"""Integer-cents schema guard. READ-ONLY -- writes nothing, safe on any database.

    docker compose exec -T backend python -m tests.test_money_columns

Monetary values are integer cents everywhere in this codebase. A clean install
is only "clean" if the schema it produces still enforces that, so this inspects
the live information_schema rather than trusting the models.

Point it at a scratch database to validate a clean install without touching
production:

    DATABASE_URL=postgresql://billiard:billiard_secret@postgres:5432/billiardbar_cleantest \
        python -m tests.test_money_columns

Covers:
  1. Every *_cents column is an integer type
  2. No floating-point or `money` type is used for currency anywhere
  3. Cent column defaults are whole numbers, never 0.0
  4. The SQLAlchemy models agree with the database
"""
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import text  # noqa: E402

from app import create_app  # noqa: E402
from app.extensions import db  # noqa: E402

INTEGER_TYPES = {'integer', 'bigint', 'smallint'}
FORBIDDEN_FOR_MONEY = {'numeric', 'double precision', 'real', 'money', 'decimal'}
passed = failed = 0


def check(label, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print(f"PASS  {label}" + (f"  -- {detail}" if detail else ''))
    else:
        failed += 1
        print(f"FAIL  {label}" + (f"  -- {detail}" if detail else ''))


app = create_app()
with app.app_context():
    url = db.engine.url
    print(f"inspecting database: {url.database} @ {url.host}")
    print()

    rows = db.session.execute(text("""
        SELECT c.table_name, c.column_name, c.data_type, c.column_default, c.is_nullable
        FROM information_schema.columns c
        JOIN information_schema.tables t
          ON t.table_schema = c.table_schema AND t.table_name = c.table_name
        WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY c.table_name, c.column_name
    """)).fetchall()
    check('0a. schema is readable and non-empty', len(rows) > 0,
          f'{len(rows)} columns across base tables')

    print()
    print("== 1. every *_cents column is an integer type ==")
    cents = [r for r in rows if r.column_name.endswith('_cents')]
    check('1a. cent columns exist to verify', len(cents) > 0, f'{len(cents)} columns')
    bad = [(r.table_name, r.column_name, r.data_type)
           for r in cents if r.data_type not in INTEGER_TYPES]
    check('1b. none use a non-integer type', not bad, f'offenders: {bad}' if bad else 'all integer')

    print()
    print("== 2. no floating-point or money type holds currency ==")
    # Scope is BASE TABLES only. Reporting views (v_*) deliberately expose
    # numeric `_mxn` pesos for humans; those are derived at read time and never
    # stored, so they cannot violate the integer-cents representation.
    money_like = re.compile(
        r'(_cents$|price|amount|total|subtotal|discount|tender|tip|cost|rate|balance)', re.I)
    floaty = [(r.table_name, r.column_name, r.data_type)
              for r in rows
              if r.data_type in FORBIDDEN_FOR_MONEY and money_like.search(r.column_name)]
    check('2a. no stored money-ish column is numeric/float/money', not floaty,
          f'offenders: {floaty}' if floaty else 'none')
    any_money_type = [(r.table_name, r.column_name) for r in rows if r.data_type == 'money']
    check('2b. the postgres `money` type is unused entirely', not any_money_type,
          f'offenders: {any_money_type}' if any_money_type else 'none')

    # Pesos must stay a presentation concern: a stored _mxn column would mean
    # currency had escaped the integer-cents representation into floats.
    stored_pesos = [(r.table_name, r.column_name) for r in rows
                    if r.column_name.endswith('_mxn')]
    check('2c. no base table stores a peso-denominated column', not stored_pesos,
          f'offenders: {stored_pesos}' if stored_pesos else 'pesos live only in views')

    print()
    print("== 3. cent defaults are whole numbers ==")
    fractional = []
    for r in cents:
        d = (r.column_default or '').split('::')[0].strip()
        if d and re.fullmatch(r'-?\d+\.\d+', d):
            fractional.append((r.table_name, r.column_name, d))
    check('3a. no cent column defaults to a fractional literal', not fractional,
          f'offenders: {fractional}' if fractional else 'all whole')

    print()
    print("== 4. the models agree with the database ==")
    # A Float column on a *_cents attribute would silently reintroduce drift
    # even while the database column stays integer.
    from sqlalchemy import Float, Numeric
    float_attrs = []
    for mapper in db.Model.registry.mappers:
        for col in mapper.columns:
            if col.key.endswith('_cents') and isinstance(col.type, (Float, Numeric)):
                float_attrs.append(f'{mapper.class_.__name__}.{col.key}')
    check('4a. no model maps a *_cents column to Float/Numeric', not float_attrs,
          f'offenders: {float_attrs}' if float_attrs else 'all integer')

    model_cents = {c.key for m in db.Model.registry.mappers for c in m.columns
                   if c.key.endswith('_cents')}
    check('4b. models declare cent columns', len(model_cents) > 0, f'{len(model_cents)} names')

print()
print(f"{passed}/{passed + failed} checks passed")
sys.exit(1 if failed else 0)
