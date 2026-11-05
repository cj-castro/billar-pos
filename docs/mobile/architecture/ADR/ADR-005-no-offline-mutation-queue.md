# ADR-005: No offline mutation queue

## Status
Accepted (D7)

## Problem
Wi-Fi in a bar is flaky. Should the app queue writes while offline and replay them later?

## Options
1. Full offline queue with replay and conflict handling (TanStack paused mutations or a custom outbox).
2. Reads from the last-known cache; writes blocked offline; only the order draft persists locally; Send needs connectivity.
3. No persistence at all.

## Decision
Option 2. Mutations use `networkMode: 'always'` and `retry: 0`, are never persisted, and nothing auto-resumes on reconnect. After reconnect, pending drafts are shown and the waiter taps Enviar again.

## Rationale
Replaying stale writes in a live bar is dangerous: tables get closed, items go out of stock, a ticket may be paid before the replay lands, and the backend has few conflict guards. An order delivered 20 minutes late is worse than an explicit failure. TanStack's default `networkMode: 'online'` would queue silently, so it is overridden on purpose.

## Consequences
- Waiters cannot send orders offline; they see a clear blocked state and keep the draft.
- Implementation stays small: no outbox, no conflict resolver, no background sync.
- KDS actions are blocked offline; staff fall back to printed chits if the LAN is down.
- Operations need a reliable LAN (DHCP reservation, coverage) more than the app needs cleverness.

## Reversibility
Medium. An outbox can be added behind the repository layer later, but it needs server-side idempotency for every mutation first.
