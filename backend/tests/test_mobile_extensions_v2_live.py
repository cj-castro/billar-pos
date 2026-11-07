"""Live contract test for mobile backend extensions v2 (health, socket handshake auth,
close hardening, waiter_can_close_ticket). Run against a RUNNING backend:

    cd backend && python -m tests.test_mobile_extensions_v2_live
"""
import time
import uuid

import requests

from tests.test_mobile_extensions_live import BASE, ORIGIN, FAILS, H, check, login


def put_setting(mgr, key, value):
    return requests.put('%s/settings/%s' % (BASE, key), json={'value': value}, headers=H(mgr), timeout=15)


def new_ticket(wtr, mgr, skip=()):
    tables = [t for t in requests.get(BASE + '/resources', headers=H(wtr), timeout=15).json()
              if t['type'] == 'REGULAR_TABLE' and t['status'] == 'AVAILABLE']
    r = requests.post(BASE + '/tickets', json={'resource_id': tables[0]['id']}, headers=H(wtr), timeout=15)
    tid = r.json()['id']
    items = [m for m in requests.get(BASE + '/menu/items', headers=H(wtr), timeout=15).json()
             if not m.get('requires_flavor') and m.get('is_active') and m.get('price_cents', 0) > 0]
    for m in items:
        if requests.post('%s/tickets/%s/items' % (BASE, tid), json={'menu_item_id': m['id'], 'quantity': 1},
                         headers=H(wtr), timeout=20).status_code == 201:
            break
    return tid


def run():
    r = requests.get(BASE + '/health', timeout=10).json()
    check('health server_version', r.get('server_version') == '1.1.0', r)
    check('health min_mobile_version', r.get('min_mobile_version'), r)
    check('health features', set(r.get('features', [])) >= {
        'socket_handshake_auth', 'idempotent_add_item', 'idempotent_close'}, r)

    mgr, wtr = login('manager', 'manager123'), login('waiter1', 'waiter123')
    if not requests.get(BASE + '/cash/status', headers=H(mgr), timeout=15).json()['open']:
        requests.post(BASE + '/cash/open', json={'opening_fund_cents': 0}, headers=H(mgr), timeout=15)

    try:
        import socketio
        ev = []
        s = socketio.Client()
        s.on('joined', lambda d: ev.append(('joined', d)))
        s.on('error', lambda d: ev.append(('error', d)))
        s.connect(ORIGIN, socketio_path='/socket.io', auth={'token': mgr}, wait_timeout=10)
        s.emit('join', {'room': 'manager'})
        time.sleep(1.2)
        check('SEC-05 handshake token -> manager room without payload token',
              ('joined', {'room': 'manager'}) in ev, ev)
        s.disconnect()
        ev.clear()
        s = socketio.Client()
        s.on('joined', lambda d: ev.append(('joined', d)))
        s.on('error', lambda d: ev.append(('error', d)))
        s.connect(ORIGIN, socketio_path='/socket.io', wait_timeout=10)
        s.emit('join', {'room': 'manager'})
        s.emit('join', {'room': 'kitchen'})
        time.sleep(1.2)
        check('anonymous: manager denied, public ok',
              ('joined', {'room': 'kitchen'}) in ev and ('joined', {'room': 'manager'}) not in ev, ev)
        s.disconnect()
        try:
            socketio.Client().connect(ORIGIN, socketio_path='/socket.io', auth={'token': 'bad'}, wait_timeout=5)
            check('invalid handshake token rejected', False, 'connected')
        except Exception:  # noqa: BLE001
            check('invalid handshake token rejected', True)
    except ImportError:
        print('SKIP: python-socketio not installed')

    # close hardening
    tid = new_ticket(wtr, mgr)
    total = requests.get('%s/tickets/%s' % (BASE, tid), headers=H(wtr), timeout=15).json()['total_cents']
    key = 'c-' + uuid.uuid4().hex
    url = '%s/tickets/%s/close' % (BASE, tid)
    r = requests.post(url, json={'payment_type': 'CASH', 'tendered_cents': total - 1}, headers=H(wtr, **{'Idempotency-Key': key}), timeout=15)
    check('close short tender + key -> 422 AMOUNT_MISMATCH', r.status_code == 422 and r.json().get('error') == 'AMOUNT_MISMATCH'
          and r.json().get('expected_total_cents') == total, r.text)
    r = requests.post(url, json={'payment_type': 'CASH', 'tendered_cents': total - 1}, headers=H(wtr), timeout=15)
    check('close short tender, no key -> legacy INSUFFICIENT_PAYMENT', r.status_code == 422 and r.json().get('error') == 'INSUFFICIENT_PAYMENT', r.text)
    r = requests.post(url, json={'payment_type': 'CASH', 'tendered_cents': total, 'tip_cents': 100, 'tip_source': 'SPLIT'
                                 }, headers=H(wtr, **{'Idempotency-Key': key}), timeout=15)
    check('bad SPLIT tip parts + key -> AMOUNT_MISMATCH', r.status_code == 422 and r.json().get('error') == 'AMOUNT_MISMATCH', r.text)

    put_setting(mgr, 'waiter_can_close_ticket', 'false')
    try:
        body = {'payment_type': 'CASH', 'tendered_cents': total}
        r = requests.post(url, json=body, headers=H(wtr, **{'Idempotency-Key': key}), timeout=15)
        check('waiter close gated -> 403 PIN_REQUIRED', r.status_code == 403 and r.json().get('error') == 'PIN_REQUIRED', r.text)
        r = requests.post(url, json=dict(body, manager_pin='5678'), headers=H(wtr, **{'Idempotency-Key': key}), timeout=15)
        check('waiter close with manager_pin -> 200', r.status_code == 200, r.text)
    finally:
        put_setting(mgr, 'waiter_can_close_ticket', 'true')
    r2 = requests.post(url, json=body, headers=H(wtr, **{'Idempotency-Key': key}), timeout=15)
    check('replay same key on closed -> 200 same ticket', r2.status_code == 200 and r2.json()['id'] == tid, r2.text)
    check('F1 replay same key -> change_due present', 'change_due' in r2.json(), r2.text)
    r = requests.post(url, json=body, headers=H(wtr, **{'Idempotency-Key': 'c-' + uuid.uuid4().hex}), timeout=15)
    check('F1 replay different key -> 409 TICKET_NOT_OPEN CLOSED', r.status_code == 409
          and r.json() == {'error': 'TICKET_NOT_OPEN', 'status': 'CLOSED'}, r.text)
    r = requests.post(url, json=body, headers=H(wtr), timeout=15)
    check('F1 replay no key (web) -> 200', r.status_code == 200 and r.json()['id'] == tid, r.text)

    # F4: gate only applies with Idempotency-Key (web unchanged)
    tid4 = new_ticket(wtr, mgr)
    tot4 = requests.get('%s/tickets/%s' % (BASE, tid4), headers=H(wtr), timeout=15).json()['total_cents']
    put_setting(mgr, 'waiter_can_close_ticket', 'false')
    try:
        r = requests.post('%s/tickets/%s/close' % (BASE, tid4), json={'payment_type': 'CASH', 'tendered_cents': tot4},
                          headers=H(wtr), timeout=15)
        check('F4 gate off-path: no key -> 200 (web unchanged)', r.status_code == 200, r.text)
    finally:
        put_setting(mgr, 'waiter_can_close_ticket', 'true')

    # F3: PIN lockout (waiter2; failures persist 10 min, so first miss may already be 429 on rerun)
    w2 = login('waiter2', 'waiter123')
    tid3 = new_ticket(w2, mgr)
    tot3 = requests.get('%s/tickets/%s' % (BASE, tid3), headers=H(w2), timeout=15).json()['total_cents']
    put_setting(mgr, 'waiter_can_close_ticket', 'false')
    try:
        codes = []
        for _ in range(6):
            r = requests.post('%s/tickets/%s/close' % (BASE, tid3),
                              json={'payment_type': 'CASH', 'tendered_cents': tot3, 'manager_pin': '0000'},
                              headers=H(w2, **{'Idempotency-Key': 'p-' + uuid.uuid4().hex}), timeout=15)
            codes.append(r.status_code)
        check('F3 wrong PIN x5 -> 403 then 429 PIN_LOCKED', codes[-1] == 429 and r.json().get('error') == 'PIN_LOCKED'
              and set(codes[:-1]) <= {403, 429}, codes)
    finally:
        put_setting(mgr, 'waiter_can_close_ticket', 'true')

    # F5: queue expected_from compare-and-set
    tid5 = new_ticket(wtr, mgr)
    li = requests.get('%s/tickets/%s' % (BASE, tid5), headers=H(wtr), timeout=15).json()['line_items'][0]
    qu = '%s/queue/%s/status' % (BASE, li['id'])

    def q(status, **kw):
        return requests.patch(qu, json=dict(status=status, **kw), headers=H(mgr), timeout=15)
    r = q('IN_PROGRESS', expected_from='SERVED')
    check('F5 wrong expected_from -> 409 STATUS_CHANGED', r.status_code == 409
          and r.json().get('error') == 'STATUS_CHANGED' and r.json().get('current') == li['status'], r.text)
    check('F5 no expected_from -> 200', q('READY').status_code == 200)
    r = q('IN_PROGRESS', expected_from='READY')
    check('F5 READY->IN_PROGRESS expected_from ok -> 200', r.status_code == 200, r.text)
    q('SERVED')
    q('READY')
    r = q('IN_PROGRESS', expected_from='READY')
    check('F5 READY->IN_PROGRESS after served_at -> 409', r.status_code == 409
          and r.json().get('error') == 'STATUS_CHANGED', r.text)


if __name__ == '__main__':
    run()
    print('\n%d failure(s)' % len(FAILS))
    raise SystemExit(1 if FAILS else 0)
