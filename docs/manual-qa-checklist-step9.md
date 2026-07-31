# ChelCoach Step 9 — Manual QA Checklist

Automated Playwright coverage exercises the durable upload → identify → analyze → report loop against Postgres and the local Scotty simulator. Use this checklist for behaviors automation may not fully establish.

## Visual coaching quality

- [ ] Simulator report observations read as coaching (not placeholder/lorem).
- [ ] Strengths and priorities feel distinct and actionable.
- [ ] Practice drills clearly map to priorities.
- [ ] Next-game focus is scannable in under 10 seconds.

## Mobile usability

- [ ] Upload form usable on a physical phone (thumb reach, keyboard).
- [ ] Candidate confirmation cards stack without clipping.
- [ ] Sticky top/bottom chrome does not obscure primary CTAs.
- [ ] Report sections scroll smoothly; control badges remain readable.

## Keyboard journey

- [ ] Tab order through upload selects is logical.
- [ ] Candidate radios show a visible focus ring.
- [ ] Confirm / Analyze / View report are keyboard-activatable.
- [ ] Escape does not strand focus in a dead region.

## Screen-reader announcements

- [ ] Analysis status live region announces stage changes.
- [ ] Failed / cancelled / confirmation-required states are announced.
- [ ] Report heading hierarchy starts with a clear H1-equivalent.

## Report printing

- [ ] Browser print preview shows title, summary, strengths, improvements, practice plan, next-game focus.
- [ ] Interactive-only chrome is suppressed in print.
- [ ] No storage keys or private URLs appear in print preview.

## Edge presentation

- [ ] Long coaching sentences wrap without overflow.
- [ ] Low-confidence evidence severity is not color-only.
- [ ] Source-media deleted notice is clear when video is gone.
- [ ] Short-clip limitations are honest and visible.

## Simulator copy

- [ ] Spot-check short-clip vs full-game fixture language for repetition.
- [ ] Faceoff section (when present) shows consistent win/loss totals.

## Out of scope for Step 9

- Production auth replacement (Step 10)
- Live Scotty / Cloudflare / HMAC signing
- Callback activation
- Penetration testing
