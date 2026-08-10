"""Run: cd backend && python -m tests.test_print_client"""
import io
import urllib.error
from unittest import mock

from app.services import print_client


def check(label, condition, detail=''):
    status = 'PASS' if condition else 'FAIL'
    print(f'[{status}] {label}' + (f' — {detail}' if detail and not condition else ''))
    return condition


class _FakeResp:
    def __init__(self, status):
        self.status = status
    def __enter__(self): return self
    def __exit__(self, *a): return False
    def read(self): return b'{}'


def test_success():
    with mock.patch('app.services.print_client.urlopen', return_value=_FakeResp(200)):
        ok, code, msg = print_client.send_print_job('/print', {'id': 'x'})
    return check('200 response is success', ok is True and code is None)


def test_agent_unreachable():
    with mock.patch('app.services.print_client.urlopen', side_effect=urllib.error.URLError('refused')):
        ok, code, msg = print_client.send_print_job('/print', {'id': 'x'})
    return check(
        'connection refused classifies as AGENT_UNREACHABLE',
        ok is False and code == print_client.ERROR_AGENT_UNREACHABLE,
        detail=f'got code={code}',
    )


def test_printer_error_500():
    err = urllib.error.HTTPError('url', 500, 'Internal Server Error', {}, io.BytesIO(b'{"ok":false}'))
    with mock.patch('app.services.print_client.urlopen', side_effect=err):
        ok, code, msg = print_client.send_print_job('/print', {'id': 'x'})
    return check(
        '500 with generic body classifies as PRINTER_ERROR',
        ok is False and code == print_client.ERROR_PRINTER_ERROR,
        detail=f'got code={code}',
    )


def test_printer_offline_keyword():
    err = urllib.error.HTTPError('url', 500, 'Internal Server Error', {}, io.BytesIO(b'No printer found - offline'))
    with mock.patch('app.services.print_client.urlopen', side_effect=err):
        ok, code, msg = print_client.send_print_job('/print', {'id': 'x'})
    return check(
        '"offline" in body classifies as PRINTER_OFFLINE',
        ok is False and code == print_client.ERROR_PRINTER_OFFLINE,
        detail=f'got code={code}',
    )


def main():
    results = [
        test_success(),
        test_agent_unreachable(),
        test_printer_error_500(),
        test_printer_offline_keyword(),
    ]
    if all(results):
        print('\nAll tests passed.')
    else:
        print('\nSome tests FAILED.')
        raise SystemExit(1)


if __name__ == '__main__':
    main()
