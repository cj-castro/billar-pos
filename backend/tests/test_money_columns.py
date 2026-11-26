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

# The ONE exception, by design (migration 044): a cost PER UNIT is a rate, not a
# money amount. Catsup costs 3.1746 centavos per ml; storing that as a whole
# centavo made every ml/gram recipe 5-11% wrong and cheap ingredients $0. These
# columns hold centavos with exactly 4 decimals (NUMERIC(14,4), never a float).
# Every money AMOUNT -- totals, prices, payments, tips -- stays integer cents.
RATE_COLUMNS = {
    ('inventory_items', 'unit_cost_cents'),
    ('inventory_movements', 'unit_cost_cents'),
    ('sale_item_costs', 'unit_cost_cents'),
    ('bar_count_lines', 'unit_cost_cents'),     # cost snapshot per unit at count time (050)
    ('portion_batch_outputs', 'unit_cost_cents'),  # cost of one pack from a portioning batch (056)
}
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
        SELECT c.table_name, c.column_name, c.data_type, c.column_default, c.is_nullable,
               c.numeric_precision, c.numeric_scale
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
           for r in cents
           if r.data_type not in INTEGER_TYPES and (r.table_name, r.column_name) not in RATE_COLUMNS]
    check('1b. none use a non-integer type (except the per-unit cost rates)', not bad,
          f'offenders: {bad}' if bad else 'all integer')
    rates = {(r.table_name, r.column_name): (r.data_type, r.numeric_precision, r.numeric_scale)
             for r in cents if (r.table_name, r.column_name) in RATE_COLUMNS}
    wrong_rates = {k: v for k, v in rates.items() if v != ('numeric', 14, 4)}
    check('1c. per-unit cost rates are exactly numeric(14,4) -- never float',
          len(rates) == len(RATE_COLUMNS) and not wrong_rates,
          f'{wrong_rates or rates}')

    print()
    print("== 2. no floating-point or money type holds currency ==")
    # Scope is BASE TABLES only. Reporting views (v_*) deliberately expose
    # numeric `_mxn` pesos for humans; those are derived at read time and never
    # stored, so they cannot violate the integer-cents representation.
    money_like = re.compile(
        r'(_cents$|price|amount|total|subtotal|discount|tender|tip|cost|rate|balance)', re.I)
    floaty = [(r.table_name, r.column_name, r.data_type)
              for r in rows
              if r.data_type in FORBIDDEN_FOR_MONEY and money_like.search(r.column_name)
              and (r.table_name, r.column_name) not in RATE_COLUMNS]
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
    rate_attrs = {}
    for mapper in db.Model.registry.mappers:
        for col in mapper.columns:
            if not col.key.endswith('_cents'):
                continue
            table = mapper.local_table.name
            if (table, col.key) in RATE_COLUMNS:
                rate_attrs[f'{mapper.class_.__name__}.{col.key}'] = (
                    type(col.type).__name__, getattr(col.type, 'scale', None))
            elif isinstance(col.type, (Float, Numeric)):
                float_attrs.append(f'{mapper.class_.__name__}.{col.key}')
    check('4a. no model maps a money *_cents column to Float/Numeric', not float_attrs,
          f'offenders: {float_attrs}' if float_attrs else 'all integer')
    check('4c. the per-unit cost rates are Numeric(scale 4) in the models, never Float',
          rate_attrs and all(v == ('Numeric', 4) for v in rate_attrs.values()), f'{rate_attrs}')

    model_cents = {c.key for m in db.Model.registry.mappers for c in m.columns
                   if c.key.endswith('_cents')}
    check('4b. models declare cent columns', len(model_cents) > 0, f'{len(model_cents)} names')

print()
print(f"{passed}/{passed + failed} checks passed")
sys.exit(1 if failed else 0)
