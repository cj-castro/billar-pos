# ADR-004: Idempotency-Key extension for item add (B1)

## Status
Accepted (D6, B1); backend work planned

## Problem
Retrying `POST /tickets/<id>/items` after a lost response double-applies: duplicate line, double stock deduction, second kitchen chit (G13). Wi-Fi blips make this likely on a bar floor.

## Options
1. No retry; on timeout ask the waiter to verify the ticket.
2. Client-side reconciliation (refetch the ticket and match by item, quantity and time).
3. Server-side `Idempotency-Key` stored on the line with a partial unique index.
4. Batch endpoint with a single idempotent request.

## Decision
Option 3 for v1, with Option 1 as the automatic fallback when the server does not advertise `idempotency-key`. Option 4 is a recommended later proposal (P5).

## Rationale
Option 2 is heuristic: two identical lines are legitimately possible. Option 3 is small (nullable column, partial unique index, lookup before checks) and exact. The lookup runs before the ticket-closed, stock and version checks so replays succeed even if the ticket changed meanwhile.

## Consequences
- New SQL migration `002_...` appended to `manifest.txt`; it must be deployed to the bar machine before the mobile retry path is relied on.
- A duplicate returns 200 with the existing line and no side effects; the same key with different content returns 409 `IDEMPOTENCY_KEY_REUSED`.
- Feature detection is needed (proposal P2, `api_features` on `/health`); without it the client never auto-retries.
- Only item add is covered. Other non-idempotent endpoints stay state-guarded.

## Reversibility
High. Additive and nullable; dropping the index and column restores today's behaviour. Older clients are unaffected.
