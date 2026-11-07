# API contract cheat-sheet for v2 builders

Extracted from backend code on branch `feature/mobile-pos-companion` (2026-11-05). Base `/api/v1`, `Authorization: Bearer <access>` (8h, claims `role`,`name`), refresh 7d via `POST /auth/refresh`. Errors `{"error": "<CODE>", "message"?}`; some return a sentence in `error`. Money = integer cents (MXN). Dates = `America/Mexico_City`. Rate limits: login 10/min, verify-pin 5/min, edit-payment 5/min (shared across all clients behind nginx) → 429.

## Tickets `/tickets`
Ticket: `id, ticket_type (TABLE|EXPRESS|DELIVERY), rappi_order_id, resource_id, resource_code, status (OPEN|CLOSED|CANCELLED), opened_by, opened_at, closed_at, payment_type, payment_type_2, tendered_cents, tendered_cents_2, tip_cents, tip_source, tip_cash_cents, tip_card_cents, manual_discount_pct, discount_cents, subtotal_cents, pool_time_cents, total_cents, version, customer_name, payment_requested, payment_requested_at, was_reopened, reopened_at, edited_after_close, applied_promotions[], line_items[], timer_sessions[], waiting_list_entry, available_promotions` (OPEN detail only).
Line: `id, ticket_id, menu_item_id, menu_item_name, quantity, unit_price_cents, promo_discount_cents, net_cents, promotions[{name,discount_cents}], status, routing_dest, sent_at, served_at, voided_at, void_reason, notes, needs_reprint, client_request_id, modifiers[{modifier_id,name,price_cents}]`.

- `POST /tickets` (any): `resource_id`, `ticket_type` (default TABLE; EXPRESS/DELIVERY take no resource), `rappi_order_id` (DELIVERY), `customer_name`, `waiting_list_entry_id`. 201. Errors 422 `INVALID_TICKET_TYPE`/`RAPPI_ID_REQUIRED`, **403 `BAR_CLOSED` (no OPEN cash session)**, 404, 409 `RESOURCE_OCCUPIED`. Emits `floor:update`.
- `GET /tickets?status&resource_id`, `GET /tickets/<id>`, `/active-express`, `/pending-payment`, `/reopened`. `GET /tickets/open-all` (MANAGER/ADMIN): `id, resource_code, resource_status, customer_name, opened_at, item_count, total_cents`.
- `POST /tickets/<id>/items`: headers `X-Ticket-Version` (409 `VERSION_CONFLICT`), `Idempotency-Key` `[A-Za-z0-9_-]{1,64}` (replay 200 existing line). Body `menu_item_id, quantity 1–99, modifiers[{modifier_id}], notes`. 403 `TICKET_CLOSED`, 422 `FLAVOR_REQUIRED`/`OUT_OF_STOCK`/`INVALID_QUANTITY`. 201 line + `ticket_version`.
- `PATCH /tickets/<id>/items/<item_id>`: `quantity`, `pin` (only when decreasing). 403 `MANAGER_REQUIRED`, 401 `INVALID_PIN`, 409 `ITEM_VOIDED`.
- `DELETE /tickets/<id>/items/<item_id>`: `{pin, reason}`. 403 `MANAGER_REQUIRED`, 401 `INVALID_PIN`, 409 `ALREADY_VOIDED`.
- `POST /tickets/<id>/send-order`: 400 `NO_STAGED_ITEMS`.
- `POST /tickets/<id>/transfer`: `target_resource_id`. 409 `RESOURCE_OCCUPIED`. Stops timer when leaving pool.
- `POST /tickets/<id>/request-payment` (any): 409 `TICKET_NOT_OPEN`. **Stops pool timer, frees table.** `{ok,total_cents}`.
- `POST /tickets/<id>/clear-payment-request`.
- **`POST /tickets/<id>/close` (any)**: `payment_type` CASH|CARD|EXTERNAL (EXTERNAL DELIVERY-only → 422 `EXTERNAL_PAYMENT_DELIVERY_ONLY`), `payment_type_2` CASH|CARD, `tip_source` CASH|CARD|SPLIT (default = payment_type, SPLIT if type_2), `tendered_cents`, `tendered_cents_2` (required with type_2 → 422 `TENDERED_2_REQUIRED`), `tip_cents`, `tip_cash_cents`+`tip_card_cents` (must sum → 422 `TIP_SPLIT_MISMATCH`), `expected_total_cents` (tolerates timer accrual). Non-negative ints ≤ 1e8 else 422 `INVALID_AMOUNT`. Underpay 422 `INSUFFICIENT_PAYMENT {total_cents,tip_cents,tendered_cents}` (only when tender sent; CARD/EXTERNAL omit). 409 `TICKET_NOT_OPEN`. **Already CLOSED → 200 ticket (idempotent).** Success 200 ticket + `change_due`. Stops timer, frees resource, closes waiting entry. Emits `floor:update`.
- `POST /tickets/<id>/cancel` (any, OPEN only, no PIN): 422 `HAS_ITEMS`/`HAS_POOL_TIME`, 409 `TICKET_NOT_OPEN`.
- `POST /tickets/<id>/void-timer` (MANAGER/ADMIN, no PIN): 404 `NO_ACTIVE_TIMER`. No items → ticket CLOSED; has items → becomes EXPRESS. `{ok, ticket_closed, ticket}`. Emits `floor:update`, `pool:timer_voided`.
- `PATCH /tickets/<id>/timer/<session_id>` (MANAGER/ADMIN): `start_time`, `end_time?`, `reason`. 422 `INVALID_TIMESTAMP`/`INVALID_TIME_RANGE`. No socket.
- `PATCH /tickets/<id>/discount` (MANAGER/ADMIN, no PIN): `pct` 0–100, `reason`. 409 `TICKET_NOT_OPEN`.
- `POST /tickets/<id>/promotions/<promotion_id>`: `decision` ACCEPTED|DECLINED. 404 `PROMO_NOT_FOUND`, 409 `PROMO_NOT_CONFIRMABLE`. Returns ticket + `available_promotions`. No separate remove.
- `PATCH /tickets/<id>/customer-name`: `customer_name`.
- `POST /tickets/<id>/edit-payment` (MANAGER/ADMIN + `pin`): `reason` required (422 `REASON_REQUIRED`), 401 `INVALID_PIN`, 409 `TICKET_NOT_CLOSED`, 422 `NO_CHANGES`; any payment fields. `GET /tickets/<id>/edit-history` → audit rows `{id,user_id,action,entity_type,entity_id,before_state,after_state,reason,ip_address,created_at}`.
- `POST /tickets/<id>/reopen` (MANAGER/ADMIN): `reason?`. 409 `ALREADY_OPEN`/`CASH_SESSION_CLOSED`/`RESOURCE_UNAVAILABLE`/`RESOURCE_OCCUPIED`.
- `POST /tickets/<id>/force-close` (MANAGER/ADMIN): `reason` required. 409 `TICKET_NOT_OPEN`.
- `POST /tickets/<id>/print?unpaid=true|false` (any): body `job_id?`. `{ok,job_id}`; 503 agent down. Emits `print:failed` to `manager`.
- `POST /tickets/<id>/reprint` (any JWT): `manager_id` (server checks that user is active MANAGER/ADMIN; no PIN). `{ok,job_id}`.

## Manager PIN
Body field `pin`. Inline `verify_manager_pin(pin)` on void / qty-decrease / edit-payment → 401 `INVALID_PIN`. Pre-verify `POST /auth/verify-pin {pin}` → 200 `{valid,manager_id,manager_name}` or **400** `{valid:false}`. Discount/reopen/force-close/void-timer/timer PATCH/cash: role-gated by JWT, no PIN. Mobile has `verifyPin` in `src/api/endpoints/auth.ts` and `PinPad` component.

## Cash `/cash`
- `GET /status` (any): `{open, session|null, open_tickets_count, ghost_tickets_count}`.
- `POST /open` (MANAGER/ADMIN): `opening_fund_cents`. 409 `SESSION_ALREADY_OPEN`.
- `POST /close` (MANAGER/ADMIN): `closing_cash_counted_cents`, `notes`. 404 `NO_OPEN_SESSION`, 409 `OPEN_TICKETS`. → `{session, summary}`.
- `GET /current/summary`, `GET /<id>/summary` → `{session, summary}`; 404 `NO_OPEN_SESSION`.
- `GET /sessions` (MANAGER/ADMIN): last 30. `GET /current/tickets`: closed tickets this session `{id,customer_name,resource_code,resource_type,status,payment_type,total_cents,tip_cents,closed_at,was_reopened}`.
- `GET /current/expenses`; `POST /current/expenses` (MANAGER/ADMIN): `amount_cents, payee, description` required, `payment_method` CASH|CARD. `DELETE /expenses/<id>`.
- `GET|PUT /tip-distribution`: `floor_pct, bar_pct, kitchen_pct` sum 100.
- Summary: `ticket_count, total_sales_cents, total_tips_cents, cash_sales_cents, card_sales_cents, cash_tips_cents, card_tips_cents, total_expenses_cents, cash_expenses_cents, card_expenses_cents, tip_payout_cents, opening_fund_cents, expected_cash_cents, closing_cash_counted_cents, cash_over_short_cents, expenses[], tip_distribution{...}|null`. No socket events → refetch after mutations and on `ticket:updated`/`floor:update`.

## Reports `/reports` (MANAGER/ADMIN), params `from`,`to` YYYY-MM-DD (Mexico local). Bare arrays.
- `/sales`: `item_id,item_name,category,routing,units_sold,gross_cents,discounts_cents` (sum client-side).
- `/pool-time`: `table_code,sessions,total_seconds,revenue_cents`.
- `/promotions`: `promotion_id,promotion_name,promo_type,tickets_count,applications,units_discounted,gross_cents,discount_cents,net_cents`.
- `/payments`: `payment_type,ticket_count,total_cents,tips_cents,split_count,unique_tickets,split_tickets`.
- `/voids`: `ticket_id,table_code,item_name,category,quantity,unit_price_cents,reason,voided_at,voided_by,ticket_opened_by`.
- `/staff`: `user_id,staff_name,role,tickets_opened,tickets_closed,total_sales_cents,total_tips_cents,cash_sales_cents,card_sales_cents`.
- `/peak-hours`: `hour,ticket_count,revenue_cents,tips_cents,avg_ticket_cents`.
- `/export` CSV. Web "today" = `from=to=localToday()` with `toLocaleDateString('en-CA',{timeZone:'America/Mexico_City'})`.

## Earnings `/reports/earnings` (ADMIN), `from`,`to`
- `""`: `ingresos_cents, ingresos_barra_cents, ingresos_rappi_cents, cogs_cents, ganancia_cents, margen_pct, pool_cents, items_sin_costo[], items_sin_costo_count`.
- `/by-category`: `{rows:[{category,ingresos_cents,cogs_cents,ganancia_cents,note?}], total}`. `/by-staff`: `{rows:[{user_id,staff_name,...}], total}`.

## Analytics `/analytics/overview` (ADMIN), `from`,`to` (default last 30d)
`rango, comparativo, totales{ventas_cents,billar_cents,venta_articulos_cents,costo_cents,utilidad_cents,utilidad_total_cents,propinas_cents,descuentos_cents,tickets,dias_operados,ticket_promedio_cents,venta_diaria_promedio_cents,margen_pct,cobertura_costo_pct}, variacion_pct{ventas,tickets,utilidad}, serie_diaria[], mezcla_pago[{metodo,monto_cents,propina_cents,pagos}], por_hora[{hora,tickets,venta_cents,utilidad_cents}], por_categoria[{categoria,unidades,venta_cents,utilidad_cents}], pronostico_7d[], nota_cobertura`.

## Safe `/safe` (ADMIN)
`GET ""?from&to` → `[{id,amount_cents,notes,created_at,collector_name,collector_username}]`; `POST ""` `{amount_cents>0, notes}`; `DELETE /<id>`; `GET /summary` → `{total_collections,total_amount_cents}`.

## Waiting list `/waiting-list` (JWT; `move` MANAGER/ADMIN)
Entry: `id, party_name, party_size, notes, status (WAITING|SEATED|ASSIGNED|CANCELLED|NO_SHOW), position, created_at, assigned_at, assigned_resource_id, assigned_resource_code, assigned_ticket_id, floor_resource_id, floor_resource_code, floor_ticket_id, created_by_name, wait_seconds`.
- `GET ""` (WAITING+SEATED by position), `GET /history`.
- `POST ""`: `party_name` req, `party_size` ≥1, `notes`, `floor_ticket_id?`, `floor_resource_id?`. 201. Emits `waiting_list:update`.
- `POST /<id>/assign`: `resource_id`. 409 `RESOURCE_OCCUPIED`/`RESOURCE_INACTIVE`, 403 `BAR_CLOSED`. 201 `{entry, ticket}`. Emits `floor:update`.
- `PATCH /<id>/status`: `status` CANCELLED|NO_SHOW. `POST /<id>/dequeue`. `PATCH /<id>/move`: `direction` up|down. `POST /<id>/transfer-to-pool`: `pool_resource_id`.
- Socket names: both `waiting:update` and `waiting_list:update` are emitted — subscribe to both.

## Resources `/resources`
Field `type`: `POOL_TABLE|REGULAR_TABLE|BAR_SEAT`. Resource: `id, code, name, type, status (AVAILABLE|IN_USE|INACTIVE), is_active, is_temp, sort_order, active_ticket_id, customer_name`, pool with running timer: `timer_start` (ISO), `timer_session_id`; `pool_config {billing_mode PER_MINUTE|ROUND_15|PER_HOUR, rate_cents, promo_free_minutes}`. Live elapsed = now − timer_start (client-side; use clockSkew). No live cost served; estimate = rate × elapsed per billing_mode.
Timer session: `id, ticket_id, resource_id, resource_code, status, start_time, end_time, duration_seconds, billing_mode, rate_cents, promo_free_seconds, promo_free_seconds_effective, charge_cents, is_manual_edit`.

## Menu `/menu`
Item: `id, category_id, name, price_cents, requires_flavor, is_active, sort_order, routing (KITCHEN|BAR), ingredient_count, modifier_groups[]`. No sold-out flag; stock enforced via 422 `OUT_OF_STOCK` + `inventory/stock-check`. Group: `id, name, is_mandatory, min_selections, max_selections, allow_multiple, split_modifier_qty, modifiers[]`.

## Health
`GET /health` → `{status:"ok"}` today. Phase 0 adds `server_version, min_mobile_version, features[]`.

## Mobile existing endpoint modules (`mobile/src/api/endpoints/`)
auth(login,refresh,logout,me,verifyPin) · tickets(getTicket,listTickets,openTicket,addItem,requestPayment,voidItem,updateQty) · ticketOps(addItemIdem,listPendingPayment,cancelTicket,setCustomerName,transferTicket,setDiscount,printPreBill) · managerTickets(listOpenAll,listPendingPayment) · cash(getCashStatus) · inventory(stockCheck) · menu(listCategories,listItems,listModifiers) · queue(getQueue,getCounts,updateStatus) · resources(listResources) · settings(getSetting,putSetting) · health(health).
Missing: close, edit-payment, reopen, force-close, promotions, timer PATCH, void-timer, reprint, waiting list, cash open/close/expenses/summary/sessions, reports, earnings, analytics, safe.

## Mobile components (`mobile/src/components/`)
AppButton(48/56dp) · AppText · AppTextField · BottomActionBar(disabled-reason line) · ConfirmDialog(danger) · ConnectionPill · DraftLineRow · EmptyState · ErrorState(ApiError) · GroupGuard · IconButton · KdsAgeBadge · KdsTicketCard · LanguageToggle · LoadingSkeleton · Logo · MenuItemTile · ModifierGroup · OfflineBanner · PinPad(auto-submit 4–6) · QuantityStepper · ScreenHeader · ScreenScaffold · SectionHeader · StatTile(null→"—") · StatusChip(icon+word) · TableCard · TicketLine · Toast(action) · tabBar.tsx · connection.ts.

## Gotchas
1. `verify-pin` invalid → 400; inline PIN invalid → 401. Handle both.
2. Reprint trusts `manager_id`, no PIN.
3. Cash/reports/safe/menu/earnings emit no sockets.
4. `get_or_404` routes return non-JSON 404.
5. Ticket create / waiting assign fail 403 `BAR_CLOSED` when cash session closed → tell waiter "Caja cerrada, pide al gerente abrir caja".
6. Earnings/analytics on web use UTC date (bug); mobile must use Mexico date.
