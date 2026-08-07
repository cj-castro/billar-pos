# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary: waiters working the floor of a billiard pool bar, on tablets/handheld devices, opening tables, adding items to tickets, and sending orders under time pressure — errors and slow taps cost them real money and table turnover.

Secondary: kitchen staff and bar staff working order queues (likely fixed screens near their stations), and managers/admins on desktop handling floor oversight, reporting, promotions, inventory, and configuration.

## Product Purpose

A full-featured Point-of-Sale and floor management system for a billiard pool bar: live floor view of pool tables/regular tables/bar seats, pool-table time billing (per-minute, round-to-15, per-hour), ticket-based POS with items/modifiers/promotions, kitchen and bar order queues, automatic inventory deduction, and sales/pool-time/payment reporting.

## Positioning

Purpose-built for billiard bars specifically — the pool-table time billing (three modes, tied to floor/table state) and the combined floor-map + ticket + kitchen/bar queue flow are the core mechanism a generic restaurant POS does not offer.

## Operating Context

- Devices: mixed tablets (floor staff, in-hand or table-side) and desktop/laptop (manager/admin back office). Kitchen/bar queue screens likely run on fixed displays near their stations.
- Real-time: Socket.IO powers live updates across devices — floor map, queues, and ticket state must reflect other staff's actions instantly.
- Role-based access: Waiter, Kitchen, Bar, Manager, Admin — each sees a different slice of the app (see frontend/src/pages and frontend/src/pages/manager).
- Core workflows: open ticket → add items/modifiers → send to kitchen/bar → track queue status → transfer/close ticket with payment. Pool tables additionally track billed time against floor state.

## Capabilities and Constraints

- Stack (existing, not open): Backend Python 3.11 + Flask + Flask-SocketIO + SQLAlchemy; Frontend React 18 + TypeScript + Vite + Tailwind CSS; PostgreSQL 15; Docker Compose deployment.
- Confirmed functionality: floor management, pool-table time billing (3 modes), ticket-based POS with items/modifiers/flavors/promotions, kitchen & bar queues, automatic inventory deduction with void reversal, promotions (happy hour, item discounts, pool-time promos), sales/pool-time/payment reporting (CSV/JSON export), role-based access.

## Product Principles

- Waiter-on-the-floor speed rules: the busiest, most time-pressured, most error-costly role sets the bar for interaction cost across shared components.
- Real-time truth: any screen showing floor/table/queue/ticket state must never lie to staff mid-shift — live updates are load-bearing, not decorative.
- Role-scoped surfaces: waiter, kitchen, bar, and manager/admin are distinct jobs-to-be-done, not one interface with hidden panels.
- Tablet-first, desktop-capable: floor-facing screens must hold up on a tablet in hand; back-office screens can lean into desktop density.
- Money and inventory correctness over visual flourish: billing, voids/reversals, and reporting are the trust surface of the product.

## Accessibility & Inclusion

No product-specific accessibility requirement established yet; treat as undecided rather than assumed.
