/**
 * Wire types, hand-written from backend `to_dict()` shapes
 * (docs/mobile/discovery/API_CAPABILITY_MATRIX.md). Money = integer cents.
 */

export type Role = 'WAITER' | 'KITCHEN_STAFF' | 'BAR_STAFF' | 'MANAGER' | 'ADMIN';
export const ROLES: readonly Role[] = ['WAITER', 'KITCHEN_STAFF', 'BAR_STAFF', 'MANAGER', 'ADMIN'];

export interface User {
  id: string;
  username: string;
  name: string;
  /** Kept as string on the wire: unknown values are routed to /denied. */
  role: Role | (string & {});
  is_active?: boolean;
  has_pin?: boolean;
  created_at?: string | null;
}

export type ResourceType = 'BAR_SEAT' | 'POOL_TABLE' | 'REGULAR_TABLE';
export type ResourceStatus = 'AVAILABLE' | 'IN_USE' | 'INACTIVE';

export interface PoolConfig {
  billing_mode: string;
  rate_cents: number;
  promo_free_minutes: number | null;
}

export interface Resource {
  id: string;
  code: string;
  name: string;
  type: ResourceType;
  status: ResourceStatus;
  is_active: boolean;
  is_temp: boolean;
  sort_order: number;
  pool_config?: PoolConfig | null;
  active_ticket_id?: string | null;
  customer_name?: string | null;
  timer_start?: string;
  timer_session_id?: string;
}

export type TicketStatus = 'OPEN' | 'CLOSED' | 'CANCELLED';
export type TicketType = 'TABLE' | 'EXPRESS' | 'DELIVERY';
export type LineItemStatus = 'STAGED' | 'SENT' | 'IN_PROGRESS' | 'READY' | 'SERVED' | 'VOIDED';
export type RoutingDest = 'KITCHEN' | 'BAR';

export interface LineItemModifier {
  id: string;
  modifier_id: string;
  name: string;
  price_cents: number;
}

export interface TicketLineItem {
  id: string;
  ticket_id: string;
  menu_item_id: string;
  menu_item_name: string;
  quantity: number;
  unit_price_cents: number;
  promo_discount_cents: number;
  net_cents: number;
  promotions: unknown[];
  status: LineItemStatus;
  routing_dest: RoutingDest | null;
  sent_at: string | null;
  served_at: string | null;
  voided_at: string | null;
  void_reason: string | null;
  notes: string | null;
  needs_reprint: boolean;
  modifiers: LineItemModifier[];
}

export interface Ticket {
  id: string;
  ticket_type: TicketType;
  rappi_order_id: string | null;
  resource_id: string | null;
  resource_code: string | null;
  status: TicketStatus;
  opened_by: string;
  opened_at: string;
  closed_at: string | null;
  payment_type: string | null;
  tendered_cents: number | null;
  tip_cents: number | null;
  manual_discount_pct: number | null;
  was_reopened: boolean;
  payment_requested: boolean;
  payment_requested_at: string | null;
  subtotal_cents: number;
  discount_cents: number;
  pool_time_cents: number;
  total_cents: number;
  /** Optimistic-lock counter; sent back as `X-Ticket-Version`. */
  version: number;
  notes: string | null;
  customer_name: string | null;
  waiting_list_entry?: unknown;
  /** Only present on detail (`GET /tickets/:id`). */
  line_items?: TicketLineItem[];
  applied_promotions?: unknown[];
  timer_sessions?: unknown[];
  available_promotions?: unknown[];
}

export interface MenuCategory {
  id: string;
  name: string;
  routing: RoutingDest;
  sort_order: number;
}

export interface Modifier {
  id: string;
  name: string;
  price_cents: number;
  modifier_group_id: string;
  is_active: boolean;
  inventory_rules?: unknown[];
}

export interface ModifierGroup {
  id: string;
  name: string;
  is_mandatory: boolean;
  min_selections: number;
  max_selections: number;
  allow_multiple: boolean;
  split_modifier_qty?: boolean;
  modifiers: Modifier[];
}

export interface MenuItem {
  id: string;
  category_id: string;
  name: string;
  price_cents: number;
  requires_flavor: boolean;
  is_active: boolean;
  sort_order: number;
  routing: RoutingDest | null;
  ingredient_count?: number;
  modifier_groups?: ModifierGroup[];
}

/** Line item + resource_code, as returned by /queue/kitchen|bar. */
export interface QueueItem extends TicketLineItem {
  resource_code: string | null;
}

export type Station = 'KITCHEN' | 'BAR';

export interface CashSession {
  id: string;
  date: string | null;
  status: 'OPEN' | 'CLOSED';
  opening_fund_cents: number;
  closing_cash_counted_cents: number | null;
  opened_by: string;
  closed_by: string | null;
  opened_at: string | null;
  closed_at: string | null;
  notes: string | null;
}

export interface CashStatus {
  open: boolean;
  session: CashSession | null;
  open_tickets_count: number;
  ghost_tickets_count: number;
}

export interface StockCheck {
  blocked_items: string[];
  blocked_modifiers: string[];
  low_stock_item_ids: string[];
  remaining_by_item: Record<string, number>;
  low_stock_items: unknown[];
}

export interface Setting {
  key: string;
  value: string;
}
