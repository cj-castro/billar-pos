/* global Buffer, process */
// Creates an open table ticket with one Loaded Nachos (KITCHEN) line as waiter1; prints {ticketId}.
// Uses the same token cache as the contract tests (login is rate limited to 10/min).
// Cleanup: node e2e/maestro/seed-order.mjs --cleanup <ticketId>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = (process.env.CONTRACT_BASE_URL ?? 'http://localhost:8090') + '/api/v1';
const CACHE = path.join(os.tmpdir(), 'bola8-contract-sessions.json');
const CRED = { waiter: ['waiter1', 'waiter123'], manager: ['manager', 'manager123'] };

async function token(who) {
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch {}
  const c = cache[who];
  if (c && JSON.parse(Buffer.from(c.access_token.split('.')[1], 'base64url')).exp - Date.now() / 1000 > 60) return c.access_token;
  const r = await fetch(`${API}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: CRED[who][0], password: CRED[who][1] }) });
  if (!r.ok) throw new Error(`login ${who}: ${r.status}`);
  const s = await r.json();
  cache[who] = s;
  fs.writeFileSync(CACHE, JSON.stringify(cache));
  return s.access_token;
}
const call = async (who, method, url, body) => {
  const r = await fetch(API + url, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await token(who)}` }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => null) };
};

if (process.argv[2] === '--cleanup') {
  console.log((await call('manager', 'POST', `/tickets/${process.argv[3]}/force-close`, { reason: 'e2e cleanup' })).status);
} else {
  const st = await call('manager', 'GET', '/cash/status');
  if (!st.body.open) await call('manager', 'POST', '/cash/open', { opening_fund_cents: 0 });
  const items = (await call('waiter', 'GET', '/menu/items')).body;
  const nachos = items.find((i) => i.name === 'Loaded Nachos');
  const tables = (await call('waiter', 'GET', '/resources')).body.filter((r) => r.type === 'REGULAR_TABLE' && r.status === 'AVAILABLE');
  for (const t of tables) {
    const tk = await call('waiter', 'POST', '/tickets', { resource_id: t.id, ticket_type: 'TABLE', customer_name: 'e2e' });
    if (tk.status !== 201) continue;
    await call('waiter', 'POST', `/tickets/${tk.body.id}/items`, { menu_item_id: nachos.id, quantity: 1 });
    console.log(JSON.stringify({ ticketId: tk.body.id, table: t.code }));
    break;
  }
}
