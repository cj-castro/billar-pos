
Use each message **in order**, one at a time. Wait for Claude's response before pasting the next. Each step builds on the previous one.

---

## 🔹 MESSAGE 1 — System Audit

```
You are an expert backend + frontend architect.

We are working on an inventory system for a bar/restaurant POS.

Stack:
- Backend: Python 3.11, Flask, SQLAlchemy, PostgreSQL 15
- Frontend: React 18 + TypeScript (i18n already implemented for es/en)

Audit the CURRENT system. Focus on:

1. Inventory model (columns, types, constraints)
2. Insumos Base (menu item → inventory item linkage and deduction)
3. Restock flow (how stock is added)
4. Sale deduction logic (what happens when a ticket item is sold)

Output ONLY:

A. Current architecture summary
B. Data flow (restock → sale → deduction)
C. Issues found (classified: critical / medium / low)
D. Missing capabilities vs a production inventory system

Rules:
- Do NOT propose solutions
- Do NOT assume missing details
- If something is unclear, state: "cannot confirm from codebase"
- Be specific about file paths and model names
```

---

## 🔹 MESSAGE 2 — Gap Analysis

```
Now compare the CURRENT system you just analyzed against this TARGET DESIGN:

TARGET DESIGN:
- Each inventory item has a single `base_unit` (porción, pieza, ml, botella)
- Bilingual unit catalog (key + name_es + name_en), using the existing i18n system — no hardcoded strings
- Inventory items track `stock_quantity` and `unit_cost_cents` (weighted average)
- Weighted average cost recalculated on every restock
- COGS captured at sale finalization in a separate `sale_item_costs` table
- Insumos Base deducts a configurable quantity per sale (supports decimals for ml)
- Inventory movements ledger records every change (restock, sale deduction, adjustment, waste)
- No negative stock allowed (strict validation)
- All stock operations must be transactional and concurrency-safe
- Search bar on inventory page (name, SKU, category, supplier)
- Bulk drinks bought in cases, sold as bottles (variable pack sizes per product: Bohemia 12, Corona 24)
- Food items use a portion-based workflow: kitchen receives bulk → weighs portions → manager adds portions directly to inventory with purchase cost

Your task:

1. Identify ALL gaps between current system and target design
2. Group gaps by:
   - Schema
   - Backend logic
   - Frontend
   - Data integrity
   - Concurrency

Output ONLY:
A. Gap list
B. Impact of each gap
C. Risk if not fixed

Rules:
- Do NOT propose solutions yet
```

---

## 🔹 MESSAGE 3 — Data Model Design

```
Design the FINAL database schema that satisfies the target system.

Include these tables:

- inventory_items
- inventory_movements
- unit_catalog
- insumos_base (the menu item → inventory item link with deduction qty)
- sale_item_costs

For each table define:
- Columns with types
- Constraints (NOT NULL, UNIQUE, CHECK)
- Foreign key relationships
- Indexes

Also define:
- Numeric precision rules (DECIMAL types, cents stored as integers)
- Enum or lookup values where applicable
- Cascade/restrict rules on FKs

Output ONLY:
A. Final schema (table-by-table)
B. Constraints
C. Index strategy
D. Any seed data needed (unit catalog initial values in es + en)

Rules:
- No ORM code yet
- Must be production-safe for PostgreSQL 
- No ambiguity on column purposes
```

---

## 🔹 MESSAGE 4 — Business Logic

```
Define the backend business logic for all inventory operations.
'lb' does not have a direct catalog entry. Existing items using lb should be reviewed and either mapped to 'kilogramo' with a quantity conversion or given a new 'libra' catalog entry. This is a data migration decision, not a schema  decision. should be 'kilogramo' or Kg
Cover:

1. **Restocking** — including:
   - Drinks: user enters cases, system multiplies by `purchase_pack_size` to get bottles
   - Food portions: user enters portions directly with total purchase cost
   - Weighted average cost recalculation
   - Inventory movement log entry
   - Override of default pack size / portion yield

2. **Sale finalization / COGS capture** — including:
   - Insumos Base lookup for the sold menu item
   - Stock deduction (per unit type)
   - `unit_cost_cents` snapshot into `sale_item_costs`
   - Inventory movement log entry (type: SALE_DEDUCTION)

3. **Insumos Base deduction logic** — including:
   - Decimal quantities for ml-based ingredients
   - Integer quantities for porción/pieza/botella

4. **Inventory movements ledger** — all operations logged

5. **Waste and adjustments** — manual stock corrections

For each: step-by-step logic, edge cases, validation rules, failure conditions.

Also define:
- Concurrency handling strategy (SELECT FOR UPDATE, optimistic locking, etc.)
- Transaction boundaries

Output ONLY:
A. Logic flows (numbered steps per operation)
B. Edge cases and how they're handled
C. Validation rules
D. Concurrency strategy

Rules:
- No code — precise, executable descriptions only
```

---

## 🔹 MESSAGE 5 — API Design

```

Review bc sometimes purchase price can have decimals
Design the backend REST API.

Include endpoints for:

- GET  /api/inventory          (list with search, category filter, low-stock filter)
- GET  /api/inventory/:id      (single item with movement history)
- POST /api/inventory/restock  (add stock with cost)
- POST /api/inventory/adjust   (manual adjustment / waste)
- GET  /api/inventory/movements (filtered by item, date, type)
- GET  /api/unit-catalog       (list units with bilingual names)
- GET  /api/insumos-base       (for a menu item, list its ingredients)
- PUT  /api/insumos-base       (update ingredient links and quantities)
- POST /api/insumos-base       (add new ingredient link)

For each endpoint define:
- HTTP method and path
- Request payload (JSON schema)
- Response format
- Validation rules
- Error responses

Output ONLY:
A. Endpoint list
B. Request/response schemas
C. Validation rules

Rules:
- No implementation code
- Must align with frontend usage
- Must support the i18n unit names
```

---

## 🔹 MESSAGE 6 — Frontend Plan

```
Design the frontend implementation.

Cover:

1. **Inventory list page** — search bar, filters, stock display in base_unit, cost display
2. **Restock form** — quantity + total cost + optional note, per-unit cost preview
3. **Insumos Base editor** — on the menu item edit page, add/remove ingredients, decimal quantity for ml
4. **Unit catalog admin** — simple list showing key, name_es, name_en
5. **Inventory movement log** — read-only table per item

For each:
- Component tree
- State management approach
- API calls used
- Validation (client-side)
- i18n integration (how unit names follow the language switcher)

Output ONLY:
A. Component structure
B. Data flow per component
C. API endpoints consumed
D. UX rules (debounce timing, error display, loading states)

Rules:
- No code
- Must align with backend API from Message 5
```

---

## 🔹 MESSAGE 7 — Migration Plan

```
Create a safe migration plan from the current system to the new schema.

Include:

1. New columns on existing tables
2. New tables to create
3. Data transformation rules for:
   - Existing stock (map to new base_unit)
   - Items without purchase cost (unit_cost_cents = NULL → treated as 0)
   - Inconsistent or missing units
4. Seed data for unit_catalog
5. Rollback strategy if migration fails

Output ONLY:
A. Migration steps (ordered)
B. Data mapping rules per column
C. Risks and mitigations per step

Rules:
- Must avoid data loss
- Must be safe to run on production
- Alembic-compatible description
```

---

## 🔹 MESSAGE 8 — Implementation Plan

```
Create the step-by-step implementation plan with dependencies.

Execution order must respect:

1. Schema changes first
2. Backend services next
3. API endpoints
4. Frontend components last

Also define:
- Which steps can run in parallel
- Minimum viable deployment (what must ship together)
- Safe rollout strategy (feature flags? deploy backend before frontend?)

Output ONLY:
A. Ordered task list
B. Dependencies between tasks
C. Rollout plan

Rules:
- Minimize downtime
- Support incremental deployment where possible
- Backend must be deployed before frontend
```

---

## 🔹 MESSAGE 9 — Backend Implementation


Now implement the backend. Create a new branch named pos-inventory-v2
backup old DB first on the backups path
Stack: Python 3.11, Flask, SQLAlchemy, PostgreSQL 15

Include:
- SQLAlchemy models (all new/modified tables)
- Alembic migration file
- Service layer: restock, sale finalization, COGS capture, inventory adjustments
- API endpoints (as designed in Message 5)
- Concurrency handling (transactions, locking)
- Inventory movement logging on every stock change

Rules:
- Must follow the approved schema (Message 3) and logic (Message 4) exactly
- All stock changes must be within a transaction
- Weighted average cost calculation must be correct
- No negative stock allowed — return 422 with clear error
- All monetary values in integer cents
- Include docstrings on services

Output: Full backend code, file by file.


---

## 🔹 MESSAGE 10 — Frontend Implementation

```
Now implement the frontend. use branch pos-inventory-v2

Stack: React 18 + TypeScript, existing i18n system

Include:
- Inventory list page with search bar, filters, stock + cost display
- Restock form modal (quantity, total cost, note)
- Insumos Base editor (within existing menu item edit page)
- Unit catalog admin page
- Inventory movement log (read-only, per item)

Rules:
- Must match API contracts from Message 5 exactly
- Must handle validation errors from backend
- Must use the existing i18n pattern for bilingual unit names
- Search debounce: 300ms
- All monetary values displayed in MXN format ($, comma, period, 2 decimals)

Output: Full frontend code, file by file.
```

---

## 🔹 MESSAGE 11 — QA & Validation

```
Validate the full system implementation.

Test scenarios:

1. Restock chicken wings: 43 porciones, $1,300 total cost → verify weighted avg = $30.23
2. Sell 1 Alitas 300g → verify stock −1, COGS row created with $30.23
3. Restock same item again: 30 porciones, $900 total → verify new weighted avg
4. Sell with multiple simultaneous requests → verify no negative stock, no race condition
5. Restock Corona: 5 cases × 24 → verify 120 bottles added
6. Sell michelada → deduct 200ml Clamato, verify decimal deduction
7. Inventory movement log: verify every operation is recorded with correct type, qty, unit, cost
8. Search: verify debounce, category filter, low-stock filter
9. Language switch: verify unit names change between es/en everywhere
10. Waste/adjustment: manual stock correction, verify movement log

Edge cases:
- Restock with 0 cost → unit_cost_cents stays NULL or previous value
- Sell when stock is exactly 0 → 422 error
- Decimal quantity for ml ingredients (200ml, 30ml)
- Override pack size on restock

Output ONLY:
A. Test scenarios with expected results
B. Failure risks identified
C. Any gaps found

Rules:
- Be strict
- Assume production load
- Flag any deviation from the approved design
```

---

## 🔥 Usage Notes

- Paste **one message at a time**, in order.
- Wait for Claude's full response before pasting the next.
- Messages 1–8 are **design-only** (no code). Approve each before continuing.
- Messages 9–10 produce **code**. Review before running.
- Message 11 is **validation**. Use it to catch issues before deployment.
- The step-by-step approach costs more total tokens but prevents Claude from making wrong assumptions and saves rework. Total estimated cost across all 11 messages: **$3.50–5.50** — well within your $9.50 balance.

