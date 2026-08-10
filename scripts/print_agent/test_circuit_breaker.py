"""Run: python test_circuit_breaker.py"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import circuit_breaker as cb


def check(label, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'[{status}] {label}' + (f' — {detail}' if detail and not condition else ''))
    return condition


def main():
    ok = True
    printer = 'Cocina Comandas'

    ok &= check('fresh printer is not open', cb.is_open(printer) is False)

    for _ in range(3):
        cb.record_failure(printer)
    ok &= check('opens after threshold failures', cb.is_open(printer) is True)

    cb.record_success(printer)
    ok &= check('success resets breaker', cb.is_open(printer) is False)

    cb._FAILURE_THRESHOLD = 1
    cb._COOLDOWN_SECONDS = 0.05
    cb.record_failure(printer)
    ok &= check('opens immediately at threshold=1', cb.is_open(printer) is True)
    time.sleep(0.1)
    ok &= check('closes again after cooldown elapses', cb.is_open(printer) is False)

    if ok:
        print('\nAll tests passed.')
    else:
        print('\nSome tests FAILED.')
        sys.exit(1)


if __name__ == '__main__':
    main()
