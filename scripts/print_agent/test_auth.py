"""Run: python test_auth.py"""
import os
import sys

sys.path.insert(0, os.path.dirname(__file__))
os.environ['PRINT_AGENT_TOKEN'] = 'test-token-123'
import print_agent


def check(label, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'[{status}] {label}' + (f' — {detail}' if detail and not condition else ''))
    return condition


def main():
    client = print_agent.app.test_client()
    ok = True

    r = client.post('/print', json={'id': 'x'})
    ok &= check('POST /print without token is rejected', r.status_code == 401, f'got {r.status_code}')

    r = client.post('/print', json={'id': 'x'}, headers={'X-Print-Token': 'wrong'})
    ok &= check('POST /print with wrong token is rejected', r.status_code == 401, f'got {r.status_code}')

    r = client.post('/chit', json={'type': 'KITCHEN', 'items': []})
    ok &= check('POST /chit without token is rejected', r.status_code == 401, f'got {r.status_code}')

    r = client.get('/printers')
    ok &= check('GET /printers without token is rejected', r.status_code == 401, f'got {r.status_code}')

    r = client.get('/health')
    ok &= check('GET /health without token still works', r.status_code == 200, f'got {r.status_code}')

    r = client.post('/chit', json={'type': 'KITCHEN', 'items': []}, headers={'X-Print-Token': 'test-token-123'})
    ok &= check('POST /chit with correct token is not rejected', r.status_code != 401, f'got {r.status_code}')

    if ok:
        print('\nAll tests passed.')
    else:
        print('\nSome tests FAILED.')
        sys.exit(1)


if __name__ == '__main__':
    main()
