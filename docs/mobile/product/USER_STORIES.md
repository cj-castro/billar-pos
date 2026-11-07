# User Stories

Format: As a [role], I want [action] so that [outcome]. Feature IDs from `ROLE_FEATURE_MATRIX.md`. Criteria in `ACCEPTANCE_CRITERIA.md`.

## Cross-cutting (US-X)

| ID | Pri | Feature | Story |
|---|---|---|---|
| US-X-01 | P0 | F-X-01 | As any staff member, I want to enter the POS server address on first launch and see it validated, so that the app connects without a hardcoded IP. |
| US-X-02 | P0 | F-X-01 | As any staff member, I want to change the server address from the login screen, so that I can recover when the POS machine's IP changes. |
| US-X-03 | P0 | F-X-02 | As any staff member, I want to log in with username and password, so that my actions are attributed to me. |
| US-X-04 | P0 | F-X-03 | As any staff member, I want to reopen the app and be still logged in (and have my token silently refreshed), so that I don't re-login mid-shift. |
| US-X-05 | P0 | F-X-04 | As any staff member, I want to land on the screen for my role, so that I start work immediately. |
| US-X-06 | P0 | F-X-05 | As any staff member, I want to see connection status and "last updated" when offline, so that I know whether data is current. |
| US-X-07 | P0 | F-X-06 | As any staff member, I want to log out, so that nobody else uses my session on a shared phone. |
| US-X-08 | P0 | F-X-07 | As any staff member, I want the UI in Spanish by default, so that I can use it without training. |
| US-X-09 | P1 | F-X-08 | As any staff member, I want to switch to English, so that non-Spanish speakers can use the app. |
| US-X-10 | P0 | F-X-09 | As any staff member, I want the app to reconnect and refresh after Wi-Fi drops or the app returns to foreground, so that I don't act on stale data. |
| US-X-11 | P0 | F-X-10 | As any staff member, I want clear Spanish error messages for any server failure, so that I know what to do next instead of seeing a crash or raw HTML. |

## Waiter (US-W)

| ID | Pri | Feature | Story |
|---|---|---|---|
| US-W-01 | P0 | F-W-01 | As a waiter, I want a floor overview of tables by type with status, customer name, timer start and bill-requested flag, so that I see where to go. |
| US-W-02 | P0 | F-W-02 | As a waiter, I want a "Bar cerrado" banner when no cash session is open, so that I'm not surprised by a failed open-table. |
| US-W-03 | P0 | F-W-03 | As a waiter, I want to open a table, so that I can start taking an order. |
| US-W-04 | P0 | F-W-04 | As a waiter, I want to see a ticket's lines, kitchen status, server total and pool timer estimate, so that I can answer guests accurately. |
| US-W-05 | P0 | F-W-05 | As a waiter, I want to browse the menu by category and search it, so that I can find items quickly. |
| US-W-06 | P0 | F-W-06 | As a waiter, I want to pick modifiers with required groups enforced, so that I don't send an incomplete order. |
| US-W-07 | P0 | F-W-07 | As a waiter, I want to set quantity and a note per line, so that the kitchen gets the guest's exact request. |
| US-W-08 | P0 | F-W-08, F-X-11 | As a waiter, I want to build a draft and press Enviar once, so that I never accidentally or doubly send items to the kitchen. |
| US-W-09 | P0 | F-W-09 | As a waiter, I want an in-app alert when one of my items is READY, so that I serve it hot. |
| US-W-10 | P0 | F-W-10 | As a waiter, I want to mark an item served, so that the kitchen queue clears. |
| US-W-11 | P0 | F-W-11 | As a waiter, I want to request the bill, so that the cashier knows the table is ready to pay. |
| US-W-12 | P0 | F-W-12 | As a waiter, I want to cancel a ticket I opened by mistake, so that the table isn't blocked. |
| US-W-13 | P1 | F-W-13 | As a waiter, I want to void an item with a manager PIN, so that wrong items are removed with approval. |
| US-W-14 | P1 | F-W-14 | As a waiter, I want to change line quantity (decrease with PIN), so that I can fix orders. |
| US-W-15 | P1 | F-W-15 | As a manager, I want to apply a discount with PIN confirmation, so that comps are controlled. |
| US-W-16 | P1 | F-W-16 | As a waiter, I want to transfer a ticket to another free table. |
| US-W-17 | P1 | F-W-17 | As a waiter, I want to set the customer name on a ticket. |
| US-W-18 | P1 | F-W-18 | As a waiter, I want to accept or decline a promo for a ticket. |
| US-W-19 | P1 | F-W-19 | As a waiter, I want to view the waiting list. |
| US-W-20 | P1 | F-W-20 | As a waiter, I want to open an express (no-table) ticket. |
| US-W-21 | P1 | F-W-21 | As a waiter, I want to print a pre-bill. |
| US-W-22 | P1 | F-W-22 | As a waiter, I want sold-out items greyed out in the menu. |
| US-W-23 | P2 | F-W-23 | As a waiter, I want to add parties to the waiting list and assign them a table. |
| US-W-24 | P2 | F-W-24 | As a waiter, I want to create a temporary table. |

## Kitchen / Bar (US-K)

| ID | Pri | Feature | Story |
|---|---|---|---|
| US-K-01 | P0 | F-K-01 | As kitchen/bar staff, I want my station's queue grouped by table, so that I prepare orders together. |
| US-K-02 | P0 | F-K-02 | As kitchen/bar staff, I want item age colour-coded, so that I prioritise late items. |
| US-K-03 | P0 | F-K-03 | As kitchen/bar staff, I want notes and modifiers prominent, so that I make the item correctly. |
| US-K-04 | P0 | F-K-04 | As kitchen/bar staff, I want to advance items SENT -> IN_PROGRESS -> READY -> SERVED in order, so that waiters see progress. |
| US-K-05 | P0 | F-K-05 | As kitchen/bar staff, I want new/voided items to appear/disappear without manual refresh. |
| US-K-06 | P0 | F-K-06 | As kitchen/bar staff, I want a loud warning when the live connection is lost, so that I don't trust a frozen list. |
| US-K-07 | P1 | F-K-07 | As kitchen/bar staff, I want sound/vibration on new items (if enabled in settings). |
| US-K-08 | P2 | F-K-08 | As kitchen/bar staff, I want to reprint a chit. |

## Manager (US-M)

| ID | Pri | Feature | Story |
|---|---|---|---|
| US-M-01 | P0 | F-M-01 | As a manager, I want an ops overview (cash session state, open tickets, queue counts, oldest waiting item), so that I supervise the floor from anywhere. |
| US-M-02 | P0 | F-M-02 | As a manager, I want the list of tickets awaiting payment, so that I can speed up the cashier. |
| US-M-03 | P0 | F-M-03 | As a manager, I want to open any ticket (read-only) and use waiter actions, so that I can help staff. |
| US-M-04 | P1 | F-M-04 | As a manager, I want to view and advance the KDS. |
| US-M-05 | P1 | F-M-05 | As a manager, I want to void items and discount from my phone with PIN. |
| US-M-06 | P2 | F-M-06 | As a manager, I want to open/close the cash session from my phone. |

## Admin (US-A)

| ID | Pri | Feature | Story |
|---|---|---|---|
| US-A-01 | P0 | F-A-01 | As an admin, I want a diagnostics screen (server URL, health, socket, version, user/role, last sync), so that I can troubleshoot on site. |
| US-A-02 | P1 | F-A-02 | As an admin, I want to toggle `kds_sound_enabled` and `print_bar_tickets`. |
| US-A-03 | P2 | F-A-03 | As an admin, I want to list users (read-only). |
| US-A-04 | P0 | (inherits F-M-*) | As an admin, I want everything a manager has, so that I'm not limited by a lower role. |
