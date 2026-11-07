# ADR-003: Order composition as a local draft with an explicit Send

## Status
Accepted (D5, D6)

## Problem
`POST /tickets/<id>/items` creates the line as SENT immediately (inventory consumed, chit printed). There is no server-side staged state (`send-order` always returns 400). A waiter composing an order must not trigger the kitchen on every tap.

## Options
1. Add each item straight to the ticket (web behaviour).
2. Local draft, persisted on the device, posted line by line when the waiter taps Enviar.
3. Implement a server staging state and a working `send-order`.

## Decision
Option 2. Draft lines live in a persisted zustand store, namespaced by user and ticket. Each line gets a UUID `client_request_id` when created. Send is sequential with the button locked; lines in `sending` or `failed` are locked from editing.

## Rationale
Matches the waiter mental model, avoids accidental kitchen sends, and needs no schema change beyond the idempotency key (ADR-004). Option 3 is a larger backend change touching inventory and printing.

## Consequences
- The draft is local state: lost on uninstall, invisible to other staff until sent.
- Sends are per line: a partial send is possible and the kitchen gets one chit per line (proposal P5, a batch endpoint, would fix both).
- Draft prices are display snapshots only; the server prices at add time.
- A menu change while a draft exists can fail a line (inactive or out of stock); it surfaces as failed with the server message.

## Reversibility
High. Switching to direct-add or a batch/staging endpoint changes only the send service and the draft store.
