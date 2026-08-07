---
name: Bola 8 Pool Club — Monochrome Crest
description: A high-contrast, monochrome operations console built around the club's real crest mark
colors:
  ink-0: "#09090b"
  ink-1: "#131315"
  ink-2: "#1c1c1f"
  ink-3: "#28282c"
  line: "#3a3a3f"
  line-bright: "#54545a"
  paper: "#f4f4f5"
  paper-dim: "#c9c8c2"
  paper-mute: "#8f8e89"
  signal-green: "#16a34a"
  signal-green-text: "#4ade80"
  signal-red: "#dc2626"
  signal-red-text: "#f87171"
  signal-amber: "#d97706"
  signal-amber-text: "#fcd34d"
  signal-emerald: "#059669"
  signal-violet: "#7c3aed"
typography:
  display:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontWeight: 800
  body:
    fontFamily: "Inter, system-ui, sans-serif"
    fontWeight: 400
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"
---

# Design System: Bola 8 Pool Club — Monochrome Crest

## Overview

**Creative North Star: "The Monochrome Crest"**

The previous system ("Night Shift Console") read as generic — slate-and-blue is the default a hundred other AI-assisted dashboards land on, and its emoji icon vocabulary is an unmistakable "assembled, not designed" tell. This system replaces both by deriving directly from the club's own real asset: the black-and-white circular crest logo (dotted ring, geometric block caps, an 8-ball at center). Instead of inventing a new visual world, the interface extends the logo's own grammar — dashed-ring badges, disciplined monochrome, one drawn icon set — into every screen.

Color is reserved entirely for state (green = available, red = in use, amber = time-sensitive/waiting). There is no separate "primary accent" hue: interactivity is carried by white/near-white fills on a near-black ground, the same way a stamped ticket or an embossed badge reads as "the important thing" without needing a fourth color.

**Key Characteristics:**
- True monochrome base (near-black `#09090b` ground, near-white `#f4f4f5` ink) — no blue-gray "slate" tint
- Every table/resource renders as a dashed-ring medallion badge, echoing the logo's own crest ring
- State color is exclusively semantic (green/red/amber) — white/paper carries interactivity, never state
- Archivo (geometric, blocky caps) for numerals and display moments; Inter for body text
- Section headers use a dot + label + hairline device, not emoji + uppercase text
- A small hand-drawn single-stroke SVG icon set (`components/Icon.tsx`) replaces emoji throughout — in progress, see banner above

## Colors

### Neutral (the base — this system is monochrome-first)
- **Ink 0** (`#09090b`): page background.
- **Ink 1** (`#131315`): nav bars, resting card surfaces.
- **Ink 2 / Ink 3** (`#1c1c1f` / `#28282c`): elevated/hover surfaces.
- **Line / Line Bright** (`#3a3a3f` / `#54545a`): default and hover border weight.
- **Paper / Paper Dim / Paper Mute** (`#f4f4f5` / `#c9c8c2` / `#8f8e89`): text hierarchy, brightest to most muted.

### State (the only place color appears)
- **Green** (`#16a34a`/`#4ade80`): available, confirm, success.
- **Red** (`#dc2626`/`#f87171`): in-use, danger, void.
- **Amber** (`#d97706`/`#fcd34d`): waiting, time-sensitive, caution.
- **Emerald / Violet**: reserved narrowly for admin-only money surfaces (cash/safe = emerald, earnings = violet), unchanged from the prior system.

### Named Rules
**The One Hue, One Meaning Rule.** Color never carries "this is clickable" — only "this is available/busy/waiting." A button's affordance comes from being a solid white/paper fill or an outlined ghost, never from an accent hue.

## Typography

**Display Font:** Archivo (weight 800) — numerals, table codes, page titles, money totals.
**Body Font:** Inter — everything else.

**Character:** Archivo's geometric, slightly condensed block caps echo the crest logo's own lettering. Used sparingly — only where a number or word needs to read as a stamp, not a sentence.

## Shapes

Circular dashed-ring "medallion" badges (echoing the crest's own dotted ring) for every resource/table. Elsewhere, corners stay tight (4–8px) rather than the soft rounded-2xl the prior system used — a deliberate shift toward "solid, professional, engraved" rather than "soft app card."

## Elevation & Depth

Unchanged from the prior system: flat by default, shadow reserved for modals/floating surfaces only.

## Components

### Resource Badge (ResourceCard)
- Dashed-ring circular medallion, Archivo numeral inside.
- State as a small flat pill below the medallion (`bg-{state}-950 text-{state}-400`), not a glow or colored card fill.
- In-use: red ring + a red pulse (unchanged animation, `prefers-reduced-motion` respected).

### Section Headers
- Dot + label (Archivo, tracked caps) + hairline trailing to the right. Replaces uppercase-text-plus-emoji headers.

### Buttons
- **Primary:** solid white/paper fill, `text-zinc-900` (dark) text — the "stamp" affordance.
- **Confirm/Danger/Caution:** unchanged semantic fills (green/red/amber), white text.
- **Ghost:** outlined, zinc text, no fill.

### Icons
- `components/Icon.tsx`: single-stroke (1.6px) line icons, no fill except where a glyph needs it. Replaces emoji. NavBar, ResourceCard, and FloorMapPage's primary actions are converted; TicketPage, AddItemModal, the kitchen/bar queues, and the manager back-office pages still use emoji pending the next pass.

## Do's and Don'ts

### Do:
- **Do** keep color exclusively semantic — if you reach for a hue for a button that isn't a state, use white/paper instead.
- **Do** use the dashed-ring medallion for any new "one resource, one glance" card.
- **Do** use `components/Icon.tsx` for any new icon; never add an emoji.

### Don't:
- **Don't** reintroduce a blue/sky "primary accent" — interactivity is white/paper, not a hue.
- **Don't** use `slate-*` Tailwind classes — this app uses `zinc-*` exclusively for neutrals.
- **Don't** add a solid white (`bg-white`) fill without pairing it with `text-zinc-900` — white-on-white text is an invisible-text bug this system hit once already.
