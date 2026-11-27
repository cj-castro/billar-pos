"""Cash count denomination service (pure, no database).

    docker run --rm --entrypoint python -v "$PWD:/repo" -w /repo/backend \\
        billar-pos-backend -m tests.test_cash_count_svc
"""
import sys

from app.services import cash_count_svc as svc

PASS = FAIL = 0


def check(label, cond, detail=''):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f'PASS  {label}')
    else:
        FAIL += 1
        print(f'FAIL  {label} {detail}')


def raises(fn, code, key=None):
    try:
        fn()
    except svc.CountError as e:
        return e.code == code and (key is None or e.key == key)
    except Exception:
        return False
    return False


d = svc.denominations('MXN')
by = {x['key']: x for x in d}
check('12 MXN rows', len(d) == 12, len(d))
check('order', [x['key'] for x in d] == ['B1000', 'B500', 'B200', 'B100', 'B50', 'B20',
                                          'C20', 'C10', 'C5', 'C2', 'C1', 'C0.50'])
check('B20/C20 cents+kind', by['B20']['cents'] == 2000 and by['C20']['cents'] == 2000
      and by['B20']['kind'] == 'BILL' and by['C20']['kind'] == 'COIN')
check('C0.50 is 50', by['C0.50']['cents'] == 50)
check('cents list', [x['cents'] for x in d] == [100000, 50000, 20000, 10000, 5000, 2000,
                                                 2000, 1000, 500, 200, 100, 50])
d.append({'key': 'X'})
check('fresh list each call', len(svc.denominations('MXN')) == 12)
check('USD empty', svc.denominations('USD') == [])
check('total_cents', svc.total_cents({'B500': 3, 'C0.50': 3}, 'MXN') == 150150)
check('total empty', svc.total_cents({}, 'MXN') == 0)
check('merge duplicates',
      svc.parse_lines([{'key': 'B500', 'qty': 2}, {'key': 'B500', 'qty': 1}], 'MXN') == {'B500': 3})
check('drop zero rows', svc.parse_lines([{'key': 'B500', 'qty': 0}, {'key': 'C1', 'qty': 2}], 'MXN') == {'C1': 2})
check('unknown denom', raises(lambda: svc.parse_lines([{'key': 'B300', 'qty': 1}], 'MXN'), 'UNKNOWN_DENOMINATION', 'B300'))
check('unknown denom other currency', raises(lambda: svc.parse_lines([{'key': 'B500', 'qty': 1}], 'USD'), 'UNKNOWN_DENOMINATION'))
check('negative', raises(lambda: svc.parse_lines([{'key': 'B500', 'qty': -1}], 'MXN'), 'NEGATIVE', 'B500'))
check('float', raises(lambda: svc.parse_lines([{'key': 'B500', 'qty': 1.5}], 'MXN'), 'NOT_INTEGER'))
check('str', raises(lambda: svc.parse_lines([{'key': 'B500', 'qty': '2'}], 'MXN'), 'NOT_INTEGER'))
check('bool', raises(lambda: svc.parse_lines([{'key': 'B500', 'qty': True}], 'MXN'), 'NOT_INTEGER'))
check('None', raises(lambda: svc.parse_lines([{'key': 'B500', 'qty': None}], 'MXN'), 'NOT_INTEGER'))
check('duplicates netting negative still rejected',
      raises(lambda: svc.parse_lines([{'key': 'B500', 'qty': 2}, {'key': 'B500', 'qty': -1}], 'MXN'), 'NEGATIVE'))
check('split', svc.split({'B500': 4, 'C10': 20}, {'C10': 20, 'B500': 2}) == {'B500': 2})
check('split exceeds', raises(lambda: svc.split({'C10': 5}, {'C10': 6}), 'LEFT_EXCEEDS_COUNTED', 'C10'))
check('split key not counted', raises(lambda: svc.split({}, {'C1': 1}), 'LEFT_EXCEEDS_COUNTED', 'C1'))
check('CountError is ValueError', issubclass(svc.CountError, ValueError))

print(f'\n{PASS} passed, {FAIL} failed')
sys.exit(1 if FAIL else 0)
