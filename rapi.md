I need to implement Rappi delivery order integration into our kitchen system. 
Rappi is our only food delivery partner. Orders come from Rappi's API, not manual entry.

**Stack**: Python 3.11 + Flask + Flask-SocketIO + SQLAlchemy + PostgreSQL 15
**Frontend**: React 18 + TypeScript + Vite + Tailwind CSS
**Real-time**: Socket.IO
**Printing**: Windows thermal printers via a local print agent on :9191, to be converted into a Windows service

### Core Requirements

#### 1. Orders from Rappi API (not manual entry)
### Rappi API Integration (from official docs: dev-portal.rappi.com)

**Authentication**: OAuth2 client_credentials grant.
- Token endpoint: POST https://rests-integrations.auth0.com/oauth/token
- Body: { "client_id", "client_secret", "audience": "https://int-public-api-v2/api", "grant_type": "client_credentials" }
- Token goes in header: `x-authorization: bearer {token}`
- Token expires in 1 week. Must handle refresh/re-generation.

**Base URLs**:
- Development: https://microservices.dev.rappi.com/api/v2/restaurants-integrations-public-api
- Production: https://{COUNTRY_DOMAIN}/api/v2/restaurants-integrations-public-api

**Order Fetching** (two strategies — implement both, prefer webhook):
1. **Polling**: GET /orders (all new) or GET /orders/status/sent (only SENT state). Poll every 30-60 seconds.
2. **Webhooks** (preferred): Configure via PUT /webhook/{event}/add-stores for the order.created event. Our backend exposes an endpoint that receives the order payload in real-time.

**Order Lifecycle** (actions our system must call back to Rappi):
- PUT /orders/{orderId}/take/{cookingTime} — accept the order (triggered when kitchen slip prints)
- PUT /orders/{orderId}/reject — reject if items unavailable
- POST /orders/{orderId}/ready-for-pickup — mark ready (triggered when kitchen marks RAPPI_FULFILLED)

**Menu & SKU Mapping**:
- GET /menu returns all products with their `sku` field
- Each product has `name`, `sku`, `price`, `type` (PRODUCT/TOPPING), and optional `children` (modifiers)
- We must map Rappi SKUs to our internal MenuItem IDs. Strategy: add a `rappi_sku` column to MenuItem or a separate mapping table.

**Token Storage & Refresh**:
- Store client_id, client_secret, audience in env vars
- Store the access_token and its expiry timestamp in the database (or a file)
- On 401 response, re-generate token via POST /oauth/token and retry
- If refresh fails, raise an alert and flag the order for manual fallback

**Order Payload** (from webhook or GET /orders):
- The order object includes: orderId, customer name, delivery address, items array (with SKUs, quantities, modifiers), total amount, and optionally a tracking URL.
- Map this to our internal Ticket + rappi_orders row:
  - Ticket: source='RAPPI', status='NEW'
  - rappi_orders: rappi_order_id, delivery_address, tracking_url, customer_name
  - Items: match by SKU → our MenuItem, create order items with quantities

**Important printer detail**: One of the printers ("cocina comandas") is connected via Bluetooth, not USB/network. The print agent must:
- Verify the Bluetooth printer is paired and connected before sending a job; if not, attempt reconnection or queue the job with a retry.
- Handle intermittent disconnections gracefully (log warning, retry, notify staff if persistent).
- The Windows service should monitor the BT connection health, especially on system startup when BT stack might take a moment to initialize.
- If the BT printer is "la barra" (counter), ensure the driver ticket printing isn't silently lost if the printer is momentarily unreachable.

#### 2. Separate Rappi Kitchen Tab
- New "Rappi" tab inside the existing Kitchen Display (KDS) page (open same page, add tab switcher "Floor" / "Rappi")
- Rappi orders appear ONLY as kitchen production requests
- Use the existing kitchen kanban component verbatim, just filter by `ticket.source`
- Order lifecycle: New → Preparing → Ready → RAPPI_FULFILLED

#### 3. Kitchen Slip Printing (production ticket)
- Immediately upon receiving a Rappi order, print a kitchen slip via the local Windows print agent
- Content: "RAPPI" header, Rappi order ID, items with qty/modifiers/instructions, NO pricing/total
- Printer: "cocina comandas" (existing kitchen printer)
- The slip is for the kitchen to prepare food, NOT a customer-facing bill

#### 4. Rappi Driver Ticket Printing (separate)
- Simultaneously print the driver-facing Rappi ticket (the one the delivery rider takes)
- We generate this ticket using the data from Rappi: customer name, full delivery address, item list with prices, order total, Rappi order ID, and a QR code (see below)
- Printer: "la barra" (front counter, where the rider picks up)
- QR code: If Rappi provides a `tracking_url`, encode that. Otherwise encode the Rappi order ID as text.

#### 5. Inventory Deduction Without Affecting Floor Sales
- Rappi orders must decrement inventory quantities exactly like floor orders, using the existing `inventory_svc.consume_for_line_item`
- Rappi orders are EXCLUDED from all revenue/cash-session queries by adding `AND t.source='FLOOR'` to relevant clauses
- End-of-day report: separate line for Rappi orders (external payment)
- Cash session: Rappi total shown as reference only, not part of cash to declare
- Inventory reports remain neutral (all channels deducted)

#### 6. Print Agent as Windows Service (P1)
- The current print agent runs as a Python script on the Windows host (:9191). We need it to:
  - Run as a Windows service (no visible CMD window)
  - Start automatically when the machine boots (if restarted)
  - Stay alive in the background 24/7
- Implementation: use `pywin32` (`win32serviceutil`) or NSSM to wrap the current `print_agent.py` as a service
- The service must log output to a file and recover gracefully from printer errors
- Both printers are on the same Windows host; differentiate with two env vars:
  - `KITCHEN_PRINTER_NAME=cocina comandas` (existing, for kitchen slip)
  - `COUNTER_PRINTER_NAME=la barra` (new, for driver ticket)
- The backend calls the print agent via HTTP `POST http://localhost:9191/print` with a payload specifying printer name and print data

### Technical Architecture Decisions (already made)

| Decision | Answer |
|----------|--------|
| New Order table or extend Ticket? | Extend Ticket (`source='RAPPI'`) + sibling `rappi_orders` table |
| Avoid payment row? | Defense in depth: never set `payment_type`, AND filter all revenue queries with `source='FLOOR'` |
| Generate driver ticket or wait for Rappi? | Generate ourselves using Rappi order data; can swap in Rappi's PDF later if needed |
| Print timing? | Both slips print immediately at order acceptance |
| Reuse KDS or new page? | Same KDS page, new "Rappi" tab |
| Printers? | Same Windows host, two printers: "cocina comandas" (kitchen), "la barra" (counter) |
| Status column? | Widen from VARCHAR(10) to VARCHAR(20), add 'RAPPI_FULFILLED' |
| QR code? | Use Rappi's `tracking_url` if available, else encode Rappi order ID as plain text |

### Implementation Plan Request

Provide a detailed step-by-step implementation plan (no code yet) covering:

1. **Schema changes**: Ticket `source` field + `rappi_orders` table + status widening migration
2. **Rappi API integration module**: design for fetching/parsing orders, item mapping strategy
3. **Order processing flow**: create Ticket + rappi_orders row → deduct inventory → print both slips → emit Socket.IO event
4. **KDS tab separation**: frontend tab switcher, backend filtering by source
5. **Printing pipeline**: HTTP calls to the print agent for both slips with correct printer names
6. **Print agent as Windows service**: detailed steps to convert current `print_agent.py` into a service with auto-start
7. **Reporting segregation**: adjust revenue/cash-session queries, end-of-day report, inventory neutrality
8. **Fallback manual entry**: only a minimal admin UI for emergency manual Rappi orders

Start by analyzing our current Ticket model, inventory service, KDS page component, and the existing print agent script. Then propose the specific changes.