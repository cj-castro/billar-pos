# Monochrome Crest Redesign — Plan & Status

## Context

The user rejected the original visual system ("Night Shift Console" — slate+blue,
emoji icons) as generic/AI-slob. Full redesign approved via `/impeccable bolder`
→ `new-work` flow, grounded directly in the real Bola 8 logo (`frontend/public/logo.jpg`):
a monochrome circular crest, dotted ring, geometric block caps, checkered 8-ball.
Direction was rendered as a comp and approved by the user before implementation
started (see conversation history / commit `e10d9009` for the full derivation).

**System name:** The Monochrome Crest. Full spec is in `/mnt/ai/projects/billar-pos/DESIGN.md`.

**Core rules already established — follow these, don't re-derive:**
- `zinc-*` for all neutrals (never `slate-*`)
- No blue/sky accent — white/paper fill = "this is interactive," color (green/red/amber)
  = state only, never decoration
- **Any `bg-white` fill MUST pair with `text-zinc-900`** (or `hover:bg-white` with
  `hover:text-zinc-900`) — this bit us for real (45 invisible-text instances found
  and fixed already). Check every new one you add.
- Archivo (`font-display` Tailwind class) for numerals/display moments, Inter for body
- Emoji → replace with icons from `frontend/src/components/Icon.tsx` (14 exist:
  IconBall8, IconHouse, IconFlame, IconMug, IconChart, IconUser, IconLock, IconTrend,
  IconDoor, IconClock, IconReceipt, IconBox, IconSpark, IconPin, IconPrinter). Add new
  ones to this file in the same single-stroke (1.6px) style if a needed glyph doesn't
  exist yet — don't invent a second icon style.
- Section headers → use `frontend/src/components/SectionHead.tsx` (dot + label + hairline)
  instead of uppercase text + emoji
- Resource/table cards → the dashed-ring medallion pattern in `ResourceCard.tsx` is the
  reference implementation for "one resource, one glance" cards elsewhere

## Status

### Done (commit `e10d9009`, verified in the running app via screenshot, zero console errors)
- [x] Design tokens: Tailwind `zinc` swap, `sky`→monochrome swap, Archivo/Inter fonts,
      `index.html` title/favicon, `index.css` base colors
- [x] `NavBar.tsx` — drawn crest icon, Archivo wordmark, icons instead of emoji
- [x] `ResourceCard.tsx` — dashed-ring medallion badges (full rebuild)
- [x] `FloorMapPage.tsx` — 3 section headers converted, Venta Rápida/Rappi/bar-closed
      banner icons converted
- [x] `Icon.tsx` and `SectionHead.tsx` created
- [x] `DESIGN.md` rewritten for the new system
- [x] Fixed a pre-existing `backend/seed.py` crash (unrelated bug, was blocking the
      whole stack from starting)

### Done (this session) — full emoji pass

All emoji removed across the app. `Icon.tsx` grew from 14 to 32 icons (added
IconChair, IconUsers, IconGhost, IconX, IconWarning, IconCheck, IconTrash,
IconPencil, IconSearch, IconSettings, IconRefresh, IconBell, IconGlobe,
IconCash, IconCard, IconTag, IconEye, IconMug reused broadly). Icon-only spots
got real components; decorative text-attached emoji were deleted. Fixed:
WaitingListPanel, LoginPage (crest medallion replaces logo.jpg), TicketPage,
AddItemModal, KitchenQueuePage/BarQueuePage, all 13 manager pages, shared
components (ManagerPinDialog/PrintRetryBanner/ErrorBoundary/TransferModal/
EditPaymentModal), and FloorMapPage (leftover emoji not caught in the
original inventory). Verified: zero emoji remain (`grep` clean across
`frontend/src/**/*.tsx`), all files balanced, `bg-white` pairing checked
(3 false positives, all safe), `docker compose up -d --build frontend`
compiles clean, and Login/Floor/Ticket/Kitchen/Manager-Dashboard/Inventory/
Cash/Tables/Users screens screenshotted and visually verified in the running
app. Mechanical detector run: 19 findings, all pre-existing "gray-on-color"
contrast warnings + one font-choice note, unrelated to this pass — left as a
follow-up, not a blocker.

### Done (follow-up) — real logo swap + background watermark

User feedback: the drawn dashed-ring/`IconBall8` recreation "doesn't look
original" and wasn't the actual crest. User supplied two high-res source
PNGs (`Bola8-Logo-B&W.png` at 2084×2084, transparent alpha, black line art —
the real vector-quality crest). Derived `frontend/public/logo-mark.png`
(color-inverted to white-on-transparent for the dark UI) and
`frontend/public/favicon.png` (flattened on white, 180×180). Replaced every
drawn-crest spot with the real image: `NavBar.tsx` badge, `LoginPage.tsx`
medallion, `TicketPage.tsx` ticket-closed overlay, and the browser favicon
(was the old low-res `logo.jpg`, now deleted — no remaining references).
Added a large (`min(80vmin,900px)`), centered, very subtle (7% opacity)
fixed watermark of the same mark in `App.tsx`, present on every route.
Getting it to sit correctly *behind* page content (not smudged on top of
cards) required making the shared `.page-root` class transparent in
`index.css` (`!important` override of its own `bg-zinc-950` utility) plus
giving the watermark a negative z-index — the two together let it show in
empty canvas space while opaque cards/modals still cleanly occlude it.
`IconBall8` (the small inline drawn icon) is intentionally still used
elsewhere as a generic "this is a pool table" type glyph in lists — that's
a different job from the brand crest and was left alone.
Verified: build clean, balance checks pass, mechanical detector shows no
new findings (same pre-existing gray-on-color warnings as before),
Login/Floor/Kitchen/Manager-Dashboard screens visually confirmed.

### Not done — remaining emoji inventory (gathered, not yet fixed) — SUPERSEDED, see above

24 files still have emoji. Full grep for reference:
```
grep -rloP '[\x{1F300}-\x{1FAFF}\x{2600}-\x{27BF}]' --include="*.tsx" frontend/src
```

**Approach for each file:** most emoji are decorative (attached to text in toasts,
labels, hints) — safe to just delete. A smaller set are **icon-only** content (the
entire visual content of a button/span/badge is the emoji) — those need a real
`Icon.tsx` component swapped in, or the element breaks visually empty. The icon-only
spots found so far (re-run the detection script below if resuming after other edits):

```python
# Run from frontend/src — flags lines where the emoji IS the element's content
import re, glob
EMOJI = re.compile(r'[\U0001F300-\U0001FAFF☀-➿]')
for f in glob.glob('**/*.tsx', recursive=True):
    for i, line in enumerate(open(f, encoding='utf-8'), 1):
        if not EMOJI.search(line): continue
        if re.search(r"(>\s*[\U0001F300-\U0001FAFF☀-➿️]+\s*<)|('[\U0001F300-\U0001FAFF☀-➿️]+')|(\"[\U0001F300-\U0001FAFF☀-➿️]+\")", line):
            print(f"{f}:{i}: {line.strip()[:110]}")
```

Files still needing work, in priority order (highest-traffic first):

1. **`components/WaitingListPanel.tsx`** — header emoji, empty-state icons (🎱😔🪑🍺👻🚪),
   badges. Also still uses `bg-yellow-*` classes in a couple spots that predate the
   crest system — check those read correctly against the new monochrome ground.
2. **`pages/LoginPage.tsx`** — still uses the photo `logo.jpg`, not the drawn crest icon.
   Swap for the same dashed-ring `IconBall8` treatment `NavBar.tsx` uses (bigger, ~96px).
3. **`pages/TicketPage.tsx`** — largest remaining file. Icon-only spots: name-edit
   pencil/check/cancel (line ~462-476), close button ✕ (~1016), ID-reminder card 🪪
   (~1427). Text-attached emoji throughout (🎱 pool time labels, 💳 payment, etc.) —
   safe to strip.
4. **`components/AddItemModal.tsx`** — confirm checkmarks, category/item icons.
5. **`pages/KitchenQueuePage.tsx` / `pages/BarQueuePage.tsx`** — printing state icon
   (⏳/🖨️ ternary at ~line 55-56), reprint warning banner, success checkmark (✅).
   These two files are near-identical (shared pattern) — fix one, apply the same diff
   to the other.
6. **Manager pages** (all still on emoji, lowest traffic so lowest priority):
   `ManagerDashboard.tsx` (tile `icon:` fields — 13 emoji, straightforward swap to
   Icon.tsx components), `AnalyticsPage.tsx` (tab `icon:` fields), `InventoryPage.tsx`,
   `MenuManagementPage.tsx`, `ModifiersPage.tsx`, `PromotionsPage.tsx`,
   `TableManagementPage.tsx`, `CashSessionPage.tsx`, `EarningsPage.tsx`,
   `SafeCollectionsPage.tsx`, `UsersPage.tsx`, `PoolTableConfigPage.tsx`,
   `SettingsPage.tsx`.
7. **Shared components**: `ManagerPinDialog.tsx` (🔒), `PrintRetryBanner.tsx` (⚠️),
   `ErrorBoundary.tsx` (⚠️), `TransferModal.tsx` (✅), `EditPaymentModal.tsx`.

### After the emoji pass
- [ ] Rebuild frontend (`docker compose up -d --build frontend`), screenshot every
      major screen (Login, Floor, Ticket, Kitchen/Bar queue, ManagerDashboard, one
      manager sub-page) via the Playwright script pattern used earlier in this session
      (headless Chrome not available as `chromium-cli`; use `npx playwright` — see
      commit history / prior scratchpad scripts for the exact working invocation)
- [ ] Re-run the `bg-white` / `text-zinc-900` pairing check (script further up this
      file's git history, or re-derive: grep `bg-white` lines missing `text-zinc-900`
      or `text-black`) — do this after EVERY batch of edits, not just at the end
- [ ] Balance-check all touched files (paren/brace counts) after every batch:
  ```python
  import glob
  for f in glob.glob('frontend/src/**/*.tsx', recursive=True):
      s = open(f).read()
      if s.count('(') != s.count(')') or s.count('{') != s.count('}'):
          print("UNBALANCED:", f)
  ```
- [ ] Run the mechanical detector once at the end:
      `node /home/widowsvail/.claude/skills/impeccable/scripts/detect.mjs --json frontend/src`
- [ ] Update `DESIGN.md`'s banner comment (currently says "REDESIGN IN PROGRESS") once
      the emoji pass is complete — remove the in-progress note, or re-run
      `/impeccable document` for a from-scratch capture of the finished state
- [ ] Commit

## How to resume

Just say: **"Continue REDESIGN-PLAN.md"** (or reference this file directly). Read this
file first, then work through the "Not done" list in priority order, verifying
balance + the `bg-white` contrast rule after each file, and rebuild+screenshot at
natural checkpoints (e.g. after WaitingListPanel+LoginPage, after TicketPage+
AddItemModal, after the queue pages, after the manager pages) rather than only at
the very end — smaller verified batches beat one large unverified sweep.

The docker stack may still be running (`docker compose ps` from the project root) —
reuse it rather than rebuilding from scratch each time; only `docker compose up -d
--build frontend` is needed after frontend-only changes.
