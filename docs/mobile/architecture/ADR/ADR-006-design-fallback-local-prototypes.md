# ADR-006: Design fallback - no Claude Design, local prototypes

## Status
Accepted (D11)

## Problem
The mandate prefers a design tool, but the project rule keeps all work local and nothing leaves the machine. The app needs a UI direction before screens are built.

## Options
1. Use an external design service and import the result.
2. Produce design artifacts locally: HTML/CSS prototypes and screenshots in `docs/mobile/design/`.
3. Skip design and code screens directly.

## Decision
Option 2. Dark theme derived from the web palette (slate surfaces, sky accent, red alerts), Spanish-first copy, tokens defined once in `src/theme`. Prototypes are static HTML/CSS rendered to screenshots with local tooling.

## Rationale
Satisfies Rule 2 (no remote services), keeps design versioned beside the code, and tokens map directly to the React Native theme. Option 3 risks inconsistent screens across four roles.

## Consequences
- Prototypes are not interactive RN; final fidelity is validated on the emulator with screenshots.
- No design-to-code automation; tokens are copied by hand (a test checks the palette values).
- Design review depends on screenshots and the UI Designer workstream.
- Accessibility (contrast, 48dp touch targets, large text) must be verified on device, not assumed from HTML.

## Reversibility
High. Any external design output can be adopted later by changing `src/theme` and components; the logic layers are untouched.
