"""Live contract test for the mobile backend extensions B1-B4.

Runs against a RUNNING backend (not in-process):

    cd backend && python -m tests.test_mobile_extensions_live

Env: POS_BASE_URL (default http://localhost:8090/api/v1). Needs `requests`;
the socket section needs `python-socketio` (skipped with a notice if absent).
Uses seed users; login is rate-limited (10/min) so each role logs in once.
Exit code is non-zero if any check fails.
"""
import os
import sys
import time
import uuid

import requests

BASE = os.environ.get('POS_BASE_URL', 'http://localhost:8090/api/v1').rstrip('/')
ORIGIN = BASE.split('/api/')[0]
MANAGER_PIN = '5678'  # seed
FAILS = []


def check(name, cond, detail=''):
    print(('PASS' if cond else 'FAIL') + ': ' + name + ('' if cond else '  -> %s' % (detail,)))
    if not cond:
        FAILS.append(name)
    return cond


def login(user, pw):
    r = requests.post(BASE + '/auth/login', json={'username': user, 'password': pw}, timeout=15)
    r.raise_for_status()
    return r.json()['access_token']


def H(tok, **extra):
    return {'Authorization': 'Bearer ' + tok, **extra}


def run():
    mgr = login('manager', 'manager123')
    wtr = login('waiter1', 'waiter123')
    kit = login('kitchen', 'kitchen123')
    bar = login('barstaff', 'bar123')

    st = requests.get(BASE + '/cash/status', headers=H(mgr), timeout=15).json()
    if not st['open']:
        r = requests.post(BASE + '/cash/open', json={'opening_fund_cents': 0}, headers=H(mgr), timeout=15)
        check('cash session opened', r.status_code == 201, r.text)

    tables = [t for t in requests.get(BASE + '/resources', headers=H(wtr), timeout=15).json()
              if t['type'] == 'REGULAR_TABLE' and t['status'] == 'AVAILABLE']
    if not check('found AVAILABLE REGULAR_TABLE', bool(tables)):
        return
    r = requests.post(BASE + '/tickets', json={'resource_id': tables[0]['id']}, headers=H(wtr), timeout=15)
    if not check('waiter opened ticket (201)', r.status_code == 201, r.text):
        return
    tid = r.json()['id']

    try:
        body(mgr, wtr, kit, bar, tid)
    finally:
        r = requests.post('%s/tickets/%s/force-close' % (BASE, tid), json={'reason': 'test cleanup'},
                          headers=H(mgr), timeout=15)
        check('cleanup: ticket force-closed', r.status_code == 200, r.text)


def body(mgr, wtr, kit, bar, tid):
    items = [m for m in requests.get(BASE + '/menu/items', headers=H(wtr), timeout=15).json()
             if not m.get('requires_flavor') and m.get('is_active') and m.get('price_cents', 0) > 0]
    kitchen_items = [m for m in items if m.get('routing') == 'KITCHEN']
    bar_items = [m for m in items if m.get('routing') == 'BAR']
    url_items = '%s/tickets/%s/items' % (BASE, tid)

    def add(menu, key=None, extra=None):
        h = H(wtr, **({'Idempotency-Key': key} if key is not None else {}), **(extra or {}))
        return requests.post(url_items, json={'menu_item_id': menu['id'], 'quantity': 1},
                             headers=h, timeout=20)

    def ticket():
        return requests.get('%s/tickets/%s' % (BASE, tid), headers=H(wtr), timeout=15).json()

    def first_ok(cands, key):  # skip items that are out of stock
        r = None
        for m in cands:
            r = add(m, key)
            if r.status_code == 201:
                return m, r
        return None, r

    # ---- sockets (B4 + B2 setup) ----
    events, sio = [], None
    try:
        import socketio
        sio = socketio.Client()
        for ev in ('kitchen:item_update', 'bar:item_update', 'joined', 'error'):
            sio.on(ev, (lambda e: lambda d: events.append((e, d)))(ev))
        sio.connect(ORIGIN, socketio_path='/socket.io', wait_timeout=10)
        sio.emit('join', {'room': 'manager', 'token': mgr})
        sio.emit('join', {'room': 'kitchen'})
        sio.emit('join', {'room': 'bar'})
        time.sleep(1.5)
        joined = [d.get('room') for e, d in events if e == 'joined']
        check('B4 manager join -> joined', 'manager' in joined, events)
        check('B4 public rooms still join', 'kitchen' in joined and 'bar' in joined, events)
        events.clear()
        sio.emit('join', {'room': 'manager', 'token': wtr})
        time.sleep(1)
        check('B4 waiter token denied manager room',
              any(e == 'error' for e, _ in events) and not any(e == 'joined' for e, _ in events), events)
    except ImportError:
        print('SKIP: python-socketio not installed; socket checks skipped')
    except Exception as ex:  # noqa: BLE001
        check('socket connect', False, repr(ex))
        sio = None

    # ---- B1 ----
    key = 'k-' + uuid.uuid4().hex
    m1, r = first_ok(kitchen_items or items, key)
    if not check('B1 add with key -> 201', m1 is not None, r.text if r is not None else 'no items'):
        return
    line = r.json()
    check('B1 201 carries ticket_version (int)', isinstance(line.get('ticket_version'), int), line)
    check('B1 201 carries client_request_id', line.get('client_request_id') == key, line)
    ver1 = line['ticket_version']
    t1 = ticket()
    n1, sub1 = len(t1['line_items']), t1['subtotal_cents']
    check('B1 ticket_version == ticket.version', t1['version'] == ver1, (t1['version'], ver1))

    r = add(m1, key)
    d = r.json()
    check('B1 replay same key -> 200', r.status_code == 200, r.text)
    check('B1 replay same line id', d.get('id') == line['id'], d)
    check('B1 replay ticket_version unchanged', d.get('ticket_version') == ver1, d)
    r = add(m1, key, {'X-Ticket-Version': str(ver1 - 1)})
    check('B1 replay with stale X-Ticket-Version -> 200 (not 409)', r.status_code == 200, r.text)
    t2 = ticket()
    got = (len(t2['line_items']), t2['subtotal_cents'], t2['version'])
    check('B1 replay: line count, subtotal, version unchanged', got == (n1, sub1, ver1), got)

    m2, r = first_ok(bar_items or items, 'k-' + uuid.uuid4().hex)
    check('B1 new key -> 201', m2 is not None, r.text)
    line2 = r.json() if m2 else {}
    check('B1 new key bumps version', line2.get('ticket_version', 0) > ver1, line2)
    check('B1 new key -> distinct line', line2.get('id') != line['id'], line2)

    for bad in ('bad key!', 'x' * 65, ''):
        r = add(m1, bad)
        check('B1 invalid key %r -> 422 INVALID_IDEMPOTENCY_KEY' % bad[:10],
              r.status_code == 422 and r.json().get('error') == 'INVALID_IDEMPOTENCY_KEY', r.text)

    r = add(m1)  # no header: legacy behaviour
    check('B1 no header -> 201 (legacy), key null',
          r.status_code == 201 and r.json().get('client_request_id') is None, r.text)

    # ---- B2 / B3 ----
    def ready(item, tok):
        events.clear()
        r = requests.patch('%s/queue/%s/status' % (BASE, item['id']), json={'status': 'READY'},
                           headers=H(tok), timeout=15)
        time.sleep(1.2)
        return r

    kt, bt = (kit, bar) if line['routing_dest'] == 'KITCHEN' else (bar, kit)
    r = ready(line, kt)
    check('B2 PATCH READY -> 200', r.status_code == 200 and r.json().get('status') == 'READY', r.text)
    if sio:
        evn = line['routing_dest'].lower() + ':item_update'
        got = [d for e, d in events if e == evn]
        want = {'item_id', 'status', 'ticket_id', 'resource_code', 'menu_item_name', 'quantity', 'opened_by'}
        check('B2 %s has all fields' % evn, bool(got) and want <= set(got[0]), got)
        if got:
            tk = ticket()
            check('B2 field values', got[0]['ticket_id'] == tid and got[0]['quantity'] == 1
                  and got[0]['menu_item_name'] == line['menu_item_name']
                  and got[0]['resource_code'] == tk['resource_code']
                  and got[0]['opened_by'] == tk['opened_by'], got[0])
    if line2:
        r = ready(line2, bt)
        check('B2 other queue READY -> 200', r.status_code == 200, r.text)

        r = requests.delete('%s/tickets/%s/items/%s' % (BASE, tid, line2['id']),
                            json={'pin': MANAGER_PIN, 'reason': 'test'}, headers=H(wtr), timeout=15)
        check('void line with manager PIN -> 200', r.status_code == 200, r.text)
        r = requests.patch('%s/queue/%s/status' % (BASE, line2['id']), json={'status': 'READY'},
                           headers=H(bt), timeout=15)
        check('B3 PATCH status on voided -> 409 ITEM_VOIDED',
              r.status_code == 409 and r.json().get('error') == 'ITEM_VOIDED', r.text)
        v = [i for i in ticket()['line_items'] if i['id'] == line2['id']][0]
        check('B3 voided status unchanged', v['status'] == 'VOIDED', v['status'])

    if sio:
        sio.disconnect()


if __name__ == '__main__':
    run()
    n = len(FAILS)
    print('\nALL PASSED' if not n else '\n%d FAILED: %s' % (n, FAILS))
    sys.exit(1 if n else 0)
