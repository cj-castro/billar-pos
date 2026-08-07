---
name: Bola 8 Pool Club POS
description: Dark, high-contrast floor and order management console for a billiard bar
colors:
  night-base: "#020617"
  night-surface: "#0f172a"
  night-card: "#1e293b"
  night-input: "#334155"
  night-border: "#475569"
  night-muted: "#94a3b8"
  night-body: "#cbd5e1"
  night-bright: "#f1f5f9"
  signal-blue: "#0284c7"
  signal-blue-bright: "#0ea5e9"
  signal-blue-text: "#38bdf8"
  signal-green: "#16a34a"
  signal-green-bright: "#22c55e"
  signal-green-text: "#4ade80"
  signal-red: "#dc2626"
  signal-red-deep: "#450a0a"
  signal-red-text: "#f87171"
  signal-amber: "#d97706"
  signal-amber-text: "#fcd34d"
  signal-emerald: "#059669"
  signal-violet: "#7c3aed"
typography:
  body:
    fontFamily: "system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 700
    letterSpacing: "normal"
  action:
    fontFamily: "system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 700
rounded:
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  full: "9999px"
spacing:
  xs: "8px"
  sm: "12px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  button-primary:
    backgroundColor: "{colors.signal-blue}"
    textColor: "{colors.night-bright}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
  button-primary-hover:
    backgroundColor: "{colors.signal-blue-bright}"
  button-confirm:
    backgroundColor: "{colors.signal-green}"
    textColor: "{colors.night-bright}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  button-confirm-hover:
    backgroundColor: "{colors.signal-green-bright}"
  button-caution:
    backgroundColor: "{colors.signal-amber}"
    textColor: "{colors.night-surface}"
    rounded: "{rounded.lg}"
    padding: "12px 16px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.night-body}"
    rounded: "{rounded.lg}"
    padding: "10px 16px"
  card-resource:
    backgroundColor: "{colors.night-card}"
    rounded: "{rounded.lg}"
    padding: "16px"
  input-field:
    backgroundColor: "{colors.night-input}"
    textColor: "{colors.night-bright}"
    rounded: "{rounded.md}"
    padding: "12px 16px"
---

# Design System: Bola 8 Pool Club POS

## Overview

**Creative North Star: "The Night Shift Console"**

Bola 8 is a room that stays dark, loud, and busy until close. The interface commits to that: near-black slate surfaces throughout, no light mode, no ambient decoration competing for attention. It reads like a late-night operations console — a floor map of glowing table states, queues that spike red when something's waiting, a login screen that's really a nameplate on a locked door.

Every visual decision serves one job: a waiter glancing at a table for half a second must know its state without reading a label. Color carries that weight, not typography or iconography — the type system is a single stack (system-ui) at a handful of weights, and icons are plain emoji dropped inline rather than a designed icon set. Nothing here is trying to look designed. It's trying to be readable from three feet away, one-handed, mid-rush.

**Key Characteristics:**
- Dark-only, no light theme — near-black bases (`#020617`–`#0f172a`) throughout
- State is color-coded, not label-coded: green = available, red = occupied/urgent, amber/yellow = waiting or caution, sky = interactive/primary
- Blunt, solid-fill components — no gradients, no subtle borders doing the work, generous tap targets
- Flat by default; shadows appear only on floating surfaces (modals, the login card), never on inline cards
- Emoji as the entire icon vocabulary — a project fact worth knowing, not a rule to defend

## Colors

A near-monochrome slate scale carries the interface; a small set of fully-saturated signal colors is reserved for meaning, never decoration.

### Primary
- **Signal Blue** (`#0284c7` / hover `#0ea5e9` / text `#38bdf8`): the interactive accent — primary actions, active nav state, focus rings, links, the brand mark itself.

### Secondary
- **Signal Green** (`#16a34a` / bright `#22c55e` / text `#4ade80`): "go" — available tables, confirm/close/pay actions, positive state.
- **Signal Red** (`#dc2626` on `#450a0a` fill / text `#f87171`): "occupied / urgent" — in-use tables (paired with a pulsing border), destructive actions, queue badges.
- **Signal Amber** (`#d97706` / text `#fcd34d`): "wait / caution" — transfer actions, waitlist badges, low-stock and timer readouts.

### Tertiary
- **Emerald** (`#059669`) and **Violet** (`#7c3aed`): reserved narrowly for admin-only money surfaces (cash/safe uses emerald, earnings/analytics uses violet) — not general-purpose accents.

### Neutral
- **Night Base** (`#020617`): outermost screen background (login, floor).
- **Night Surface** (`#0f172a`): top/bottom nav bars, the default `body` background.
- **Night Card** (`#1e293b`): resting surface for cards, modals, panels.
- **Night Input** (`#334155`): form fields and secondary/ghost button fills.
- **Night Border** (`#475569`): dividers and default borders.
- **Night Muted** (`#94a3b8`): secondary/meta text (labels, timestamps, helper text).
- **Night Body** (`#cbd5e1`): default body/paragraph text.
- **Night Bright** (`#f1f5f9`): headings and emphasized text, near-white.

### Named Rules
**The One State, One Color Rule.** A given semantic state (available, in-use, waiting, danger) always resolves to the same signal color everywhere it appears — floor cards, queue badges, buttons. Never introduce a second color for a state that already has one.

## Typography

**Body Font:** system-ui, sans-serif (no custom or webfont — the system stack, unstyled by design)

**Character:** Purely functional. There is one family and a small set of weights (400 body / 700 bold for emphasis, labels, and actions); hierarchy is built with size, weight, and color, never with a second typeface.

### Hierarchy
- **Title** (bold, 20–24px): screen headers, modal titles, brand mark.
- **Body** (regular, 14–16px): default UI text, ticket line items, form values.
- **Label** (bold, 10–12px, often uppercase status words like "DISPONIBLE" / "EN USO"): state tags, meta text under a title.
- **Action** (bold, 16–18px): button copy — always bold, sized larger than surrounding body text to read as a target, not a sentence.
- **Timer/mono moment** (bold, monospace, amber): the live elapsed-time readout on an in-use pool table is the one place a monospace numeral is used, so digits don't jitter as they tick.

## Layout

Mobile-first single column that expands to a persistent top nav + desktop link row at the `md` breakpoint; a fixed bottom tab bar replaces the top nav's links below it. Floor/resource views lay out as a wrapping grid of fixed-minimum-width cards (`min-w-[120px]` for non-pool resources) so tables tile regardless of screen width. Page roots reserve bottom padding (`64px` + safe-area inset) on mobile so content never sits under the tab bar. Spacing runs on a tight rhythm — `p-4`/`px-4 py-3` for cards and fields, `gap-2`–`gap-3` between related controls — favoring density over air, consistent with a console meant to show a lot of live state at once.

## Elevation & Depth

Flat by default: inline surfaces (cards, nav bars, page backgrounds) carry no shadow and separate from each other purely through the slate lightness steps and a 1px border. Shadow is reserved for surfaces that float above the page — modals (`shadow-2xl`) and the login card (`shadow-2xl`) — signaling "this is temporarily on top," not general polish.

### Named Rules
**The Floating-Only Shadow Rule.** Shadows appear only on modals, dialogs, and the login card. An inline card that gets a drop shadow has been miscategorized as floating.

## Shapes

Rounded corners scale with a component's weight: small controls and inputs use `rounded-lg` (8px), primary/emphasized buttons and cards use `rounded-xl` (12px), full-screen modal sheets use `rounded-2xl` (16px), and anything meant to read as a pill or avatar (badges, the logo mark) uses `rounded-full`. Borders are 1px by default; a 2px border is reserved for resource cards, where it also carries state color. No sharp corners anywhere in the system.

## Components

Every interactive element is a solid color fill with bold white or near-white text — blunt and high-contrast, built for a fast decision under bar-floor pressure, not for restraint.

### Buttons
- **Shape:** `rounded-lg` (8px) for standard actions, `rounded-xl` (12px) for full-width primary actions (e.g. "Close Ticket").
- **Primary:** solid Signal Blue fill (`bg-sky-600`), white text, bold; hovers to `bg-sky-500`.
- **Confirm:** solid Signal Green fill (`bg-green-600` → hover `bg-green-500`) for affirmative, closing, or paying actions.
- **Caution:** solid Signal Amber fill (`bg-yellow-600`), dark text for contrast, for actions like table transfer that need a beat of hesitation.
- **Danger:** solid or outlined red, for destructive or logout actions.
- **Ghost/Secondary:** transparent or `bg-slate-700` fill with a `border-slate-600` outline and muted text; used for "Cancel" and non-committal actions sitting beside a primary button.
- **Disabled:** `opacity-50`, no hover state.

### Cards / Containers (Resource / Floor cards)
- **Corner Style:** `rounded-xl` (12px).
- **Background + Border:** state-driven — available is `bg-slate-800` / `border-slate-600` (hover `border-sky-500`); in-use is `bg-red-950` / `border-red-700` with a looping `pulse-red` box-shadow animation; locked is `bg-slate-900` / `border-slate-700` at `opacity-50`.
- **Border weight:** 2px (heavier than the system default 1px — the card's state color is a primary signal, not decoration).
- **Internal Padding:** 16px (`p-4`).
- **Shadow:** none — flat, per the Floating-Only Shadow Rule.

### Inputs / Fields
- **Style:** `bg-slate-700` fill, `border-slate-600` 1px border, `rounded-lg`, `px-4 py-3` padding.
- **Focus:** border shifts to Signal Blue (`focus:border-sky-500`), no glow/ring.
- **Labels:** small (`text-sm`), muted slate, sit directly above the field.

### Navigation
- **Top bar** (desktop ≥`md`): fixed, `bg-slate-900`, 1px bottom border, logo + text links + user/role chip + logout. Active link is bright white + semibold; inactive links are muted slate that brightens on hover.
- **Bottom tab bar** (mobile <`md`): fixed, `bg-slate-900`, 1px top border, emoji + label per tab, active tab text turns Signal Blue. Unread-count badges are small solid-red pills (`bg-red-500`, white text) anchored top-right of a tab/link.
- **Modals:** `bg-black/70`–`/85` backdrop, content in a `night-card` surface with `rounded-2xl` and `shadow-2xl`, entering from the bottom on mobile (`items-end`) and centered on desktop (`sm:items-center`).

## Do's and Don'ts

### Do:
- **Do** resolve every state (available/in-use/waiting/danger) to its one reserved signal color, everywhere that state appears.
- **Do** keep shadows exclusive to floating surfaces (modals, login card) — inline cards stay flat.
- **Do** use bold, oversized action text on buttons; a Night Shift Console button is a target, not a sentence.
- **Do** keep the type system to one family and a small weight set — hierarchy comes from size/weight/color, not a second typeface.

### Don't:
- **Don't** introduce a light theme or a light-background surface — the system is dark-only by design.
- **Don't** add a drop shadow to an inline/resting card; that's reserved for modals and the login card only.
- **Don't** repurpose a signal color (green/red/amber/emerald/violet) for a meaning it doesn't already carry elsewhere in the system.
- **Don't** soften the high-contrast solid-fill button style into subtle/outlined-only variants for primary actions — floor speed depends on the fill being obvious at a glance.
