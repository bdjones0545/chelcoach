---
name: chelcoach
description: Guardrails and context for building the ChelCoach app — an AI gameplay coaching MVP for NHL video-game players. Use this whenever working anywhere in the chelcoach project (screens, components, mock data, design system, the upload→scorecard→unlock conversion loop). It keeps work scoped to the MVP conversion flow and the Pro Ice Analytics design system, and prevents scope creep (other games, marketplace, social, real AI/auth/payment).
---

# ChelCoach

AI gameplay coaching app for **NHL video-game players**. Upload a clip → get a free
**Chel Rating** scorecard → see locked film-room insights → upgrade to unlock the full
AI breakdown. This is a **product-experience MVP**: no real AI, no video processing, no
payments, no auth. All analysis is polished mock data.

## The conversion loop is the product

```
Landing → Upload → Processing → Free Scorecard → Locked Film Preview → Paywall → Full Film Room
   /      /upload   /processing    /scorecard       /film-preview      /paywall    /film-room
```

Every new feature must serve this **upload → scorecard → unlock** loop. If a change
doesn't move a user along that path or make one of its steps convert better, it's out of
scope. The **Free Scorecard** and **Locked Film Preview** are the primary conversion
moments — spend polish budget there first.

## Hard rules (do not violate without explicit user request)

- ❌ Do **not** expand beyond NHL gameplay coaching to other games or sports.
- ❌ Do **not** build a marketplace, storefront, or coach-hiring feature.
- ❌ Do **not** add social features (feeds, sharing, comments, friends, leaderboards-as-network).
- ❌ Do **not** add real AI / ML / video processing until the UI/conversion MVP is fully hardened.
- ❌ Do **not** add auth or payment integration unless explicitly requested. `Start Free
  Trial` flips the mock `PremiumContext` flag — keep it mock.
- ✅ Prioritize conversion, polish, mobile-first UX, and clear product value.
- ✅ Preserve the **Pro Ice Analytics** design system.
- ✅ Prefer **local assets** over remote image URLs.
- ✅ Keep mock data **centralized** in `src/data/mockData.ts`.
- ✅ Keep components **reusable and simple**.

## Design system — Pro Ice Analytics

"Tactical dark mode" film-room aesthetic. Tokens live in `tailwind.config.js`; utilities
in `src/index.css`. Don't hardcode hex values in components — use the Tailwind tokens.

- **Colors:** Midnight navy surfaces (`background`/`surface-*`). `primary` (ice blue) for
  interactive/neutral, `tertiary` (neon green) = success/strength, `error` (crimson) =
  danger/weakness. Semantic colors are reserved for performance meaning — don't use green
  or red decoratively.
- **Type:** `Oswald` for headlines (uppercase for xl/lg), `Inter` for body, `JetBrains
  Mono` for labels/timestamps/data (`font-label-*`).
- **Depth:** glassmorphism, not drop shadows. Use `.glass-panel` (Level 1) and
  `.premium-blur` (Level 3, locked content). 1px `white/10` borders define edges.
- **Shape:** precision-softened — `rounded-lg` (4px) buttons/inputs, `rounded-xl` (8px)
  cards, pills only for status/nav.
- **Icons:** Material Symbols via the `<Icon />` component (`fill` prop for filled).

## Architecture

```
src/
  components/   Reusable UI — Icon, Button, GlassPanel, Logo, TopAppBar, BottomNav,
                MetricCard, CoachingMomentCard, AtmosphereBackground, tone.ts
  screens/      One file per step in the conversion loop
  state/        PremiumContext — mock unlock flag (isPremium / unlock / reset)
  data/         mockData.ts — ALL placeholder analysis content lives here
  assets/       Local SVG imagery (rink stills, dashboard, avatar)
  index.css     Design-system utilities & animations
```

Routing is intentionally flat (`src/App.tsx`), one route per screen. Keep it that way.

## Working conventions

- New analysis content → add it to `src/data/mockData.ts` with a typed interface, never
  inline in a component.
- New imagery → generate a local SVG in `src/assets/` matching the design tokens; import
  it (Vite resolves to a URL string). Avoid remote image URLs.
- Reuse existing primitives (`Button`, `GlassPanel`, `Icon`, `MetricCard`,
  `CoachingMomentCard`) before writing new ones.
- Locked/premium content uses `.premium-blur` + an unlock CTA that routes to `/paywall`
  when `!isPremium`.
- After changes, verify with `npm run build` (type-check + build) and a preview
  screenshot of any touched screen. Keep the console free of errors.

## Verify

```bash
npm run dev      # http://localhost:5173
npm run build    # tsc + vite build — must pass clean
```
