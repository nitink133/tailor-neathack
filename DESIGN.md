---
name: Tailor limited Neatlogs replica
description: Faithful local reproduction of the incumbent Neatlogs landing and dense trace interface.
colors:
  ground: "#fff"
  subtle: "#fafafa"
  line: "#e6e6e9"
  muted: "#71717a"
  ink: "#303034"
  bad: "#a81720"
  good: "#168352"
  landing-ground: "#f8f8fa"
  landing-ink: "#171719"
  hero-muted: "#858586"
  hack-strip: "#008db3"
  setup-ground: "#24272a"
  focus: "#2766c7"
  selected-span: "#eff5ff"
  table-header: "#f5f5f7"
  histogram-populated: "#97979f"
  failure-ground: "#fff0f1"
  error-ground: "#fff4f4"
  error-line: "#f4c3c8"
  pill-ground: "#f3f3f5"
  pill-ink: "#50505a"
  timeline-normal: "#8b8b93"
  timeline-error: "#f35966"
  dark-ground: "#151518"
  dark-subtle: "#202024"
  dark-line: "#33333a"
  dark-muted: "#a0a0aa"
  dark-ink: "#eeeef0"
  dark-bad: "#ff949b"
  dark-good: "#72d6a0"
typography:
  display:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "80px"
    fontWeight: 650
    lineHeight: 1.12
    letterSpacing: "-.04em"
  display-muted:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "58px"
    fontWeight: 600
  body:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "12px"
  entry-body:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "14px"
    lineHeight: 1.6
  app-title:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "14px"
    fontWeight: 500
  table-label:
    fontFamily: "Geist, Arial, sans-serif"
    fontSize: "10px"
    fontWeight: 500
    letterSpacing: ".02em"
  mono:
    fontFamily: "monospace"
    fontSize: "10px"
rounded:
  control: "6px"
  json: "7px"
  field: "8px"
  solid: "9px"
  bubble: "10px"
  steps: "12px"
  capsule: "20px"
spacing:
  compact: "5px"
  control-gap: "8px"
  inset: "12px"
  field-inset: "14px"
  toolbar: "18px"
  desktop-edge: "22px"
components:
  button-default:
    backgroundColor: "{colors.ground}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "7px 11px"
  button-solid:
    backgroundColor: "{colors.landing-ink}"
    textColor: "{colors.ground}"
    rounded: "{rounded.solid}"
    padding: "11px 16px"
  filter:
    rounded: "{rounded.capsule}"
    padding: "5px 10px"
  input-bubble:
    backgroundColor: "{colors.subtle}"
    rounded: "{rounded.bubble}"
    padding: "10px 14px"
  steps:
    rounded: "{rounded.steps}"
    padding: "12px 14px"
  failure:
    backgroundColor: "{colors.failure-ground}"
    textColor: "{colors.bad}"
    rounded: "{rounded.capsule}"
    padding: "4px 7px"
---

# Design System: Tailor limited Neatlogs replica

## Overview

The visual authority is the existing public Neatlogs site and authenticated Tailor Demo Sandbox observed on 11 October 2026. The approved direction is faithful reproduction of that incumbent interface. This is a bounded local proof, with no independent Tailor brand or replacement visual metaphor.

The public screen uses a silver San Francisco bridge, city and fog photograph beneath centered gray and black statements. The application uses a dense gray-and-white workspace: a narrow icon rail, compact controls, fine dividers, small labels, tabular data and restrained status colors. Trace details preserve the input, steps and output hierarchy, with an optional right graph and bottom timeline.

This document describes the built `/`, `/entry`, `/demo/:id/traces` and `/demo/:id/traces/:trace` routes. Source authority is `public/style.css` and `src/client.ts`; product boundaries and reference evidence are in `PRODUCT.md` and `docs/nit-265-reference.md`. The local finish reviewer accepted the limited scope after the mobile fixture label was resolved. Real desktop pixel parity and real responsive mobile parity remain unverified. Reference desktop crops were normalized across differing frames; no real mobile reference was inspected.

## Colors

Use the frontmatter values as extracted implementation tokens. White ground, near-white subtle surfaces, pale gray dividers, charcoal text and muted gray labels dominate the app. Dark landing ink anchors the public headline and solid CTA. Cyan belongs to the narrow hackathon strip.

Green Ready marks processing status; it does not establish a successful task outcome. Red ERROR text, a pale red error block and Execution Failed capsules communicate separate span and detection states. Timeline bars use neutral gray for normal spans and red for error spans. Blue is reserved for visible focus, span links and selected-span emphasis.

The local `.dark` theme swaps app surface, divider, text and status variables. It also uses dark failure, error and selected-span fills. It is approximate and has no certified incumbent dark-theme parity; the public landing retains its silver, light palette.

## Typography

Geist is loaded locally from `/assets/geist.woff2`, sourced from the public reference, with Arial and sans-serif fallbacks. Generic monospace serves timestamps, JSON, the setup prompt and hackathon strip. There is no separate invented display family.

The final desktop hero uses a 4.75vw main sentence bounded at 48–89.6px, weight 660 and .94 line height; the gray first sentence is .74em at weight 545. At 900px and below these become 46px and 38px; at 600px and below they become 36px and 31px, with 1.15 line height. The wordmark uses a 30px monospace treatment.

App base type is 12px; the Traces title is 14px at weight 500. Table headings are uppercase 10px with `.02em` tracking. Span names use 11px on desktop, with smaller 8–9px metadata and times. Mobile span names reduce to 9px. Entry body text is 14px at 1.6 line height, with a 35px heading reducing to 29px on mobile. Dense type is part of the observed composition, not evidence of a completed accessibility audit.

## Layout

The public hero fills the viewport below a 31px cyan strip, with a 640px desktop minimum height and 720px mobile minimum. Navigation overlays the photo. Desktop copy starts at 196px; the two CTA controls sit centered beneath it. At 900px the copy starts at 160px and at 600px at 140px; mobile actions stack. Landscape and portrait assets switch at 600px and cover the hero with bottom-centered placement. Entry uses a 610px maximum content column and a simple description form.

The application rail is fixed at 66px wide, reducing to 45px at 600px. The workspace follows that offset. A persistent synthetic/session/version notice precedes headers and controls. List structure is title and controls, capsule filters, daily histogram, dense table, then count and pagination. The table has a 1100px minimum width inside a horizontal scroll container. Rows are 38px high on desktop and 52px on mobile. The mobile first data cell includes “Retry recovers” or “Both attempts fail” below its timestamp, so fixture identity remains available before horizontally scrolling.

Detail structure is a timestamp/back toolbar, trace selector and graph/timeline toggles, a right-aligned input bubble, centered steps and root output. The flow column is at most 704px. The optional graph reserves the right 38% of the canvas and draws a fixed parent/child tree. At 900px and below it becomes a block above the flow. The optional timeline remains a horizontal bottom section, with 180px label and 55px duration columns on desktop, reducing to 110px and 40px on mobile. Bars derive position and width from span offsets and durations.

Spacing is compact and contextual: 5–8px control gaps, 12–14px panel insets, 18px toolbars and 22px desktop list edges. Preserve these relationships rather than introducing a broad spacious dashboard layout.

## Elevation & Depth

The interface has no box-shadow vocabulary. Depth comes from near-white surfaces, one-pixel dividers and borders, selected fills and nested span connectors. The public photograph supplies atmospheric depth. The toast is fixed above content with a charcoal fill; it does not introduce a floating card system. No motion parity is implemented; the hero is static rather than the incumbent's animated layered atmosphere.

## Shapes

Controls and graph roots use 6px corners, JSON blocks 7px, fields and notes 8px, solid CTAs 9px, bubbles and outlined hero actions 10px, and the steps container 12px. Filters, detections and graph children use 20px capsule corners. Most borders are one pixel in the shared divider color. Parent-child span relationships are explicit lines and indentation, with tighter indentation on mobile. Icons are reconstructed 16px outline SVGs, with reduced sizes in compact span rows.

## Components

**Buttons and navigation.** Default buttons use a white ground, fine border and compact padding; hover introduces the subtle surface. Solid entry actions use dark ink with white text. The public setup control is a dark monospace prompt beside an outlined entry CTA. Unimplemented navigation and setup controls announce that they are outside the limited demo via a status toast. Active rail navigation uses the divider fill. Many unavailable desktop controls are hidden at smaller breakpoints.

**Forms and filtering.** Entry uses a visibly labeled, required textarea, a native radio fieldset and a submit action that disables while saving and restores after failure. Errors appear in a `role="alert"` paragraph. Search, fixture, detection, tag and minimum latency controls use native inputs/selectors inside capsule popovers with explicit apply actions; they implement a bounded local condition editor. Empty results show “No traces found,” explanatory text and a clear-filters action.

**Trace table.** Keep the incumbent column order: selection, Ingested at, Status, Detections, Evals, Input, Output, Comments and Replay. Use ellipsis for dense row values and retain horizontal scrolling. Evals/comments stay empty; replay reports unavailable scope. Ready retains its screen-reader text and explanatory title. Footer counts follow the filtered rows.

**Inline spans, graph and timeline.** Span buttons expose `aria-expanded`, use circle plus/minus disclosure icons and reveal INPUT plus OUTPUT or ERROR JSON, timing and parent metadata, copy and direct-link actions. Selected spans use the blue-tinted fill. Errors have textual labels and bordered red blocks. The graph and timeline are optional toggles with `aria-pressed`; graph selection highlights its node and timeline row without opening inline JSON; timeline and direct links open the corresponding inline span using `?span=`. The graph is fixed and cannot be dragged or resized. The timeline has textual duration labels alongside its colored bars.

**Focus, feedback and accessibility.** Interactive elements have a 2px blue `:focus-visible` outline with 3px offset. Native labels, fieldsets, required validation, named icon controls and hidden Ready text provide semantic cues. Decorative SVGs are `aria-hidden`. Loading and toast feedback use `role="status"`; request failures use `role="alert"`, Retry and a path to create another session. Disabled actions reduce opacity and use a not-allowed cursor. A reduced-motion media rule prevents smooth scrolling. These are implemented patterns, not a claim of full WCAG, keyboard-navigation or assistive-technology certification.

## Do's and Don'ts

- Do preserve the gray/white density, sourced Geist, silver hero, small labels, fine dividers and incumbent composition.
- Do retain visible synthetic/local scope, two deterministic fixture identities, processing-versus-outcome semantics and accessible feedback.
- Do keep span detail inline, graph on the desktop right and timeline on the bottom; preserve the responsive graph placement and horizontal table scrolling.
- Do describe local review evidence and real-reference parity as separate findings.
- Don't introduce a new Tailor brand, decorative accent palette, card dashboard or visual metaphor into this faithful replica.
- Don't imply visitor text personalizes traces, or imply live replay, real buyer collection, model execution or real Neatlogs mutation.
- Don't treat the two-trace navigator, fixed graph, substring search or bounded capsule editors as full incumbent feature parity.
- Don't claim full marketing-page reproduction, animation parity, certified dark-theme parity, desktop pixel parity or verified real mobile parity.
- Don't treat locally sourced public assets as established redistribution or deployment permission; their current use is this local review replica.

The matching-viewport fidelity follow-up uses a 704px trace flow, 40px timeline rows, root collapse, compact trace-choice popover, curved root-to-child graph connectors and public agent SVGs. Native Comet reference and replica captures are both 1720×1410 at 100% zoom; crops use identical coordinates without resampling. See docs/nit-265-reference.md for coverage and remaining differences.

The public setup control uses the inspected agents/carbon/azure/comet variant: locally served agent SVGs and Geist Mono, circular copy icon, radial reflection, and a masked azure border rotating linearly every 2.9 seconds. Reduced motion, small viewports and coarse/no pointers disable the animated border like the reference. The local server must serve SVG assets as image/svg+xml; image decode is covered by the browser regression.
