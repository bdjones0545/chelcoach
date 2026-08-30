# WebMCP

[WebMCP](https://github.com/webmachinelearning/webmcp) lets this page publish its
own functionality to an AI agent as callable tools, through
`document.modelContext`. Instead of an agent scraping the DOM and clicking
buttons, it calls a named tool with a JSON schema and gets structured data back.

## Status of the underlying API

WebMCP is a Web Machine Learning Community Group draft. It is native in Chrome's
origin trial (Chrome 149–156) and absent in Firefox and Safari.
`navigator.modelContext` was the earlier shape and is deprecated; this code uses
`document.modelContext` only.

## Switches

Both default to off. An unset environment behaves exactly as it did before
WebMCP was added.

| Variable | Effect |
| --- | --- |
| `VITE_WEBMCP_ENABLED=true` | Register this app's tools. |
| `VITE_WEBMCP_POLYFILL=true` | Also serve them to browsers with no native WebMCP, by lazily loading `@mcp-b/global`. |

The polyfill is only ever reached through a dynamic `import()`, so it builds
into its own chunk. Builds without the flag never fetch it, and the main bundle
carries none of its weight.

## What is exposed

Four tools, all read-only:

| Tool | Returns |
| --- | --- |
| `chelcoach_get_analysis_status` | Whether an analysis exists, whether premium is unlocked, mock vs. backend report |
| `chelcoach_get_scorecard` | CHEL rating, grade, graded metrics, biggest strength and weakness |
| `chelcoach_list_coaching_moments` | Coaching moments with teasers; full breakdowns only where unlocked |
| `chelcoach_get_film_room_breakdown` | Full film room analysis; requires a completed analysis |

## Entitlements are enforced here

ChelCoach gates two things, and these tools apply the same rules rather than
trusting the caller:

- **Premium.** A moment's `teaser` is open to everyone; its `fullBreakdown` is
  not. `chelcoach_list_coaching_moments` omits `fullBreakdown` on locked moments
  and reports `locked: true` plus a count, so an agent can say *why* it cannot
  read further instead of inventing an answer.
- **A completed analysis.** `chelcoach_get_film_room_breakdown` returns an
  explicit "no analysis yet" message when the session has none, mirroring the
  film room screen's own guard.

Worth knowing: in the UI the locked breakdown is blurred with CSS, so it is
technically present in the DOM. These tools deliberately do *not* match that —
they withhold the text rather than becoming a tidier way around the paywall.

## Why every tool is read-only

A registered tool runs with whatever authority the current session already has.
An agent that could upload a clip, start an analysis, or unlock premium would be
acting on the user's behalf with no human in the loop, so no such tool exists.

`defineReadOnlyTool` is the only tool constructor, and it hard-codes
`readOnlyHint: true`. A mutating tool cannot be expressed through it. Adding
write tools is a deliberate change to `runtime.ts`, not something reachable by
accident from `tools.ts`.

## Files

| File | Role |
| --- | --- |
| `runtime.ts` | Feature detection, lazy polyfill, registration, `defineReadOnlyTool`. App-agnostic. |
| `config.ts` | Reads the two environment flags. |
| `useWebMcp.ts` | React hook; registers once, reads live data through a ref. |
| `tools.ts` | This app's tool definitions. |
| `WebMcpBridge.tsx` | Renders nothing; wires the app's contexts into the hook. |

## Verifying locally

With both flags set in `.env.local`, run the dev server and in the console:

```js
await document.modelContext.getTools();
```
