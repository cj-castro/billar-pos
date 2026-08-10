"""Run: python test_dedup_store.py"""
import os
import sys
import time

sys.path.insert(0, os.path.dirname(__file__))
import dedup_store


def check(label, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'[{status}] {label}' + (f' — {detail}' if detail and not condition else ''))
    return condition


def main():
    if os.path.exists(dedup_store._DB_PATH):
        os.remove(dedup_store._DB_PATH)

    ok = True
    ok &= check('unknown job_id is not printed', dedup_store.was_printed('job-1') is False)

    dedup_store.record_printed('job-1')
    ok &= check('recorded job_id is printed', dedup_store.was_printed('job-1') is True)

    ok &= check('empty job_id is never printed', dedup_store.was_printed('') is False)
    ok &= check('None job_id is never printed', dedup_store.was_printed(None) is False)

    dedup_store._TTL_SECONDS = 0.05
    dedup_store.record_printed('job-2')
    time.sleep(0.1)
    ok &= check('expired job_id is no longer printed', dedup_store.was_printed('job-2') is False)

    os.remove(dedup_store._DB_PATH)

    if ok:
        print('\nAll tests passed.')
    else:
        print('\nSome tests FAILED.')
        sys.exit(1)


if __name__ == '__main__':
    main()
