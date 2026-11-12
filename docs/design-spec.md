# Design spec

Apple, macOS, SF Pro and Liquid Glass are trademarks of Apple Inc. This project is not affiliated with or endorsed by Apple.

This document describes the visual design of the Gridfinity Tool Studio UI (`webapp/index.html`): tokens, component specs and the do/don't list. Use it to keep new UI consistent.

**Reference apps:** Keynote's Format inspector, Freeform's canvas, Quick Look's 3D viewer, System Settings' grouped forms.

---

## 1. Design intent and information architecture

### Intent
The window should feel like a native Mac pro tool: the tool photo and the 3D bin are the content, run edge to edge, and supply all the color on screen. Chrome is a quiet, monochrome functional layer on top. Liquid Glass is limited to three things: the trailing inspector, one small floating control capsule over the 3D view, and the trace legend chip. The inspector is a dense, System Settings-style grouped form with 13 px SF labels, tabular values with units, white lozenge slider thumbs and switches. One tinted action, **Export STL**, sits top right. Motion is plain springs, with no bounce except a press bounce on glass buttons, and the preview updates instantly while sliders move.

### Window layout (the browser viewport is the window; no fake traffic lights or title bar)

```
┌───────────────────────────────── content (1fr) ──────────────────────────────┬── inspector 300px ──┐
│ Tool Studio                                          (toolbar band, 52px)     │          [⇪ Export STL]│  ← inspector header (52px, pinned)
│ 2×5 · Pocket 61.3×172.7 mm · Bin 84×210×21 mm                                 │─ ─ soft scroll edge ─│
├──────────────── trace pane ─────────────┬┬──────────── 3D pane ───────────────┤ Tool                │
│ Trace                                   ││ Preview                 [◌ ⟳]      │ ┌─────────────────┐ │
│                                         ││                         ↑ glass    │ │Tool   Needle-nose⌃│ │
│            (photo + outlines,           ││        (bin, Quick-Look look,      │ │[Upload Photo…]  │ │
│             aspect-fit, 24px inset)     ││         grounding shadow)          │ │Symmetric tool (●)│ │
│                                         ││                                    │ └─────────────────┘ │
│ [— Tool  ▬ Pocket]  ← glass chip        ││                                    │ footer: upMsg       │
└─────────────────────────────────────────┴┴────────────────────────────────────┴─ Pocket / Finger slot / Bin / Edges
```

- **Toolbar band (content column, 52 px tall):** no background of its own. It sits on the same canvas surface as the panes, so the title floats over content and never touches a canvas drawing. Leading edge, 20 px inset: the title "Tool Studio" in Title 3 Semibold, with a subtitle line under it holding the live stats (`#cells`, `#pdim`, `#bdim`) in Subheadline, `--label-2`. There are no toolbar buttons here. Toggles never go in a toolbar (HIG), and the one primary action lives at the trailing edge.
- **Inspector (trailing, 300 px, full height, edge-to-edge regular glass):** inspector headers line up with the toolbar band. The inspector's pinned 52 px header holds **Export STL** (`#exp`), right-aligned, so it reads as the window's trailing primary action. The scrolling grouped form below it has these sections:
  1. **Tool:** a Tool pop-up (`#tool`), an **Upload Photo…** bordered button (`#upBtn`, with hidden `#upFile`), and a **Symmetric tool** switch (`#sym`). The footer is the inline status line `#upMsg`.
  2. **Pocket:** Clearance (`#clearance`, mm) and Rotation (`#rot`, °).
  3. **Finger slot:** a **Grab slot** switch row (`#slotOn`), Diameter (`#slotD`, mm) and Position (`#slotFrac`, a unitless fraction; see 3.3). Dependent rows dim to 50% when the switch is off but stay operable.
  4. **Bin:** Height (`#u`, U, with 8 tick dots) and Depth (`#depth`, mm).
  5. **Edges:** Top fillet (`#fillet`, mm) and Bottom round (`#bfillet`, mm).
- **Canvases:** the content column below the toolbar band splits **side by side** into two equal panes, with a 1 px hairline between them (the thin split-view divider). Trace is on the left and 3D on the right. Below 1100 px of viewport width the panes **stack** (trace on top), with the same hairline running horizontally. Both panes are edge-to-edge content: no card, no border and no radius. Each pane has a tiny sentence-case caption at its top left ("Trace" and "Preview"; Subheadline 11 px, weight 500, `--label-2`, plain text with no glass).
  - **Trace pane:** a neutral `--bg-canvas` surface. The photo is aspect-fit and is the only colorful thing. The legend is a small regular-glass chip at bottom left with a 12 px inset.
  - **3D pane:** a Quick Look style seamless gradient backdrop (a CSS gradient behind a transparent WebGL canvas). A regular-glass capsule floats at top right with a 12 px inset. It holds `#spin` (an unlabeled spinner with a short "Updating" label, delayed in) and `#gen` (an icon button, `arrow.clockwise`, with the tooltip "Regenerate the 3D preview").
- **Primary action:** `#exp` **Export STL** is the only tinted control in the window. `#gen` is demoted to a secondary icon, because the preview already regenerates on every change (`changed()` → `dGenerate`).
- **Upload flow:** clicking **Upload Photo…** opens the native file picker (`#upFile.click()`). While the upload runs, the script disables `#upBtn`. CSS then shows a 12 px inline spinner inside the button and dims its label. `#upMsg` sits directly under the Tool card as the section footer and carries the status. The script sets its text and its `style.color` to `var(--muted)` (working/help), `var(--accent2)` (error) or `var(--ok)` (success). Those three variables are kept as aliases of text-safe system colors (section 2). Errors stay inline next to their cause, with no alerts and no toasts. Export success gets no toast, because the browser's download UI is the confirmation.
- **Nothing critical sits at the bottom edge.** The old bottom stat strip moves into the toolbar subtitle.

---

## 2. Design tokens

Put these in `:root`. The light values are the defaults, and the dark values override them in `@media (prefers-color-scheme: dark)`. Set `color-scheme: light dark`.

```css
:root{
  color-scheme: light dark;

  /* ---------- Backgrounds ---------- */
  --bg-window:      #FFFFFF;                 /* macOS 26 windowBackground (light) */
  --bg-canvas:      #F5F5F7;                 /* trace pane + toolbar band */
  --bg-3d-top:      #FAFAFA;                 /* Quick Look backdrop, radial center */
  --bg-3d-mid:      #ECECEE;
  --bg-3d-edge:     #DEDEE1;
  --bg-underpage:   #EDEDF0;                 /* behind the inspector glass (background extension) */
  --bg-field:       #FFFFFF;                 /* text/value field + segmented selected pill */

  /* ---------- Labels (AppKit-observed, macOS 26.6) ---------- */
  --label:   rgba(0,0,0,.85);
  --label-2: rgba(0,0,0,.50);
  --label-3: rgba(0,0,0,.26);
  --label-4: rgba(0,0,0,.10);
  --label-on-accent: #FFFFFF;

  /* ---------- Fills (control backgrounds; never nested glass) ---------- */
  --fill:   rgba(0,0,0,.098);   /* push button / pop-up / switch-off track */
  --fill-2: rgba(0,0,0,.078);
  --fill-3: rgba(0,0,0,.047);   /* grouped-form card */
  --fill-4: rgba(0,0,0,.027);
  --fill-pressed: rgba(0,0,0,.16);
  --slider-track: rgba(0,0,0,.12);

  /* ---------- Separators ---------- */
  --separator:  rgba(0,0,0,.10);  /* row hairlines inside cards, pane divider */
  --hairline:   .5px;             /* use 0.5px on 2x displays; 1px fallback */

  /* ---------- System colors (macOS 26 unified) ---------- */
  --accent:      #0088FF;   /* systemBlue */
  --red:         #FF383C;
  --orange:      #FF8D28;
  --green:       #34C759;
  /* text-safe variants (increased-contrast values; >=4.5:1 on inspector glass) */
  --text-red:    #E9152D;
  --text-orange: #C55300;
  --text-green:  #008932;
  --focus-ring:  rgba(0,103,244,.50);
  --selection:   #B3D7FF;

  /* semantic */
  --destructive: var(--text-red);
  --warning:     var(--text-orange);
  --success:     var(--text-green);
  --trace-tool:   var(--accent);   /* blue outline */
  --trace-pocket: var(--red);      /* red outline + 12% fill */
  --trace-slot:   var(--orange);   /* reserved, if the slot is ever drawn */

  /* ---------- Legacy aliases used by the <script> (must exist) ---------- */
  --muted:   var(--label-2);
  --accent2: var(--text-red);
  --ok:      var(--text-green);

  /* ---------- Glass: regular, large (inspector) ---------- */
  --glass-lg-bg:     rgba(246,246,248,.72);
  --glass-lg-filter: blur(30px) saturate(180%);
  --glass-lg-rim:    inset .5px 0 0 rgba(255,255,255,.70);           /* leading-edge specular */
  --glass-lg-edge:   inset .5px 0 0 0 rgba(0,0,0,.08);                 /* split hairline */

  /* ---------- Glass: regular, small (floating capsules / chips) ---------- */
  --glass-sm-bg:     rgba(255,255,255,.58);
  --glass-sm-filter: blur(16px) saturate(170%) brightness(1.04);
  --glass-sm-rim:    inset 0 0 0 .5px rgba(255,255,255,.60), inset 0 1px 0 rgba(255,255,255,.55);
  --glass-sm-shadow: 0 4px 16px rgba(0,0,0,.12), 0 0 0 .5px rgba(0,0,0,.06);
  --glass-illum:     rgba(255,255,255,.35);   /* pointer-follow glow */

  /* ---------- Radii (concentric) ---------- */
  --r-card:     12px;   /* grouped-form card (fixed) */
  --r-control:  6px;    /* 24px push/pop-up/segment container */
  --r-field:    5px;    /* value field, stepper; segment pill = 7 - 2 */
  --r-check:    4px;
  --r-photo:    8px;    /* photo clip inside trace pane */
  --r-capsule:  999px;  /* glass capsules, switches, XL/L buttons (radius = h/2) */
  /* rule: inner = outer - padding, floor 4px. capsule 36 tall w/ 4px pad → inner button 28 tall r14 */

  /* ---------- Spacing (4/8 rhythm) ---------- */
  --sp-1: 4px; --sp-2: 8px; --sp-3: 12px; --sp-4: 16px; --sp-5: 20px; --sp-6: 24px;
  --inspector-w: 300px;
  --bar-h: 52px;              /* toolbar band + inspector header */
  --card-inset: 12px;         /* card margin from inspector edges */
  --card-pad-x: 12px;         /* row padding inside card → content x = 24px */
  --row-h: 36px;              /* single-line row (pop-up, switch, button) */
  --row-slider-h: 52px;       /* two-line slider row */

  /* ---------- Controls ---------- */
  --ctl-h-sm: 20px; --ctl-h: 24px; --ctl-h-lg: 28px; --ctl-h-xl: 36px;

  /* ---------- Type (macOS text styles; font: weight size/line-height) ---------- */
  --font: -apple-system, BlinkMacSystemFont, system-ui, "Helvetica Neue", sans-serif;
  --t-title3:   600 15px/20px var(--font);   /* toolbar title (Title 3 emphasized) */
  --t-headline: 700 13px/16px var(--font);   /* section headers */
  --t-body:     400 13px/16px var(--font);   /* row labels, values, button labels */
  --t-body-em:  600 13px/16px var(--font);   /* prominent button label */
  --t-callout:  400 12px/15px var(--font);
  --t-subhead:  400 11px/14px var(--font);   /* footers, subtitle, legend, captions(500) */
  --t-footnote: 400 10px/13px var(--font);   /* slider min/max labels */
  /* tracking (HIG macOS): 10px +.12px, 11px +.06px, 12px 0, 13px -.08px, 15px -.23px.
     Safari/CoreText applies SF tracking itself → do NOT set letter-spacing on 10–13px text.
     Only the 15px title may take letter-spacing:-.23px. Never uppercase + wide tracking. */
  --track-title3: -.23px;

  /* ---------- Shadows ---------- */
  --shadow-capsule: var(--glass-sm-shadow);
  --shadow-thumb:   0 .5px 1px rgba(0,0,0,.25), 0 2px 5px rgba(0,0,0,.15), 0 0 0 .5px rgba(0,0,0,.06);
  --shadow-knob:    0 1px 3px rgba(0,0,0,.20), 0 0 0 .5px rgba(0,0,0,.04);
  --shadow-pill:    0 1px 2px rgba(0,0,0,.12), 0 0 0 .5px rgba(0,0,0,.06);

  /* ---------- Motion ---------- */
  /* 700ms = settle time of a 0.5s perceptual spring */
  --ease-smooth: linear(0, 0.073, 0.22, 0.38, 0.525, 0.645, 0.74, 0.812, 0.866, 0.905, 0.934, 0.954, 0.968, 0.978, 0.985, 0.99, 0.993, 0.995, 0.997, 0.998, 1);
  --ease-snappy: linear(0, 0.075, 0.235, 0.413, 0.576, 0.71, 0.812, 0.886, 0.936, 0.968, 0.988, 0.999, 1.004, 1.006, 1.006, 1.005, 1.004, 1.003, 1.002, 1.002, 1);
  --ease-press:  linear(0, 0.5 8%, 1.04 25%, 0.99 45%, 1);   /* glass-button release bounce */
  --ease-ca:     cubic-bezier(.25,.1,.25,1);                  /* CA default; fallback */
  --dur-spring:  700ms;   /* smooth/snappy settle */
  --dur-press:   100ms;   /* press-in */
  --dur-release: 420ms;   /* press-out bounce */
  --dur-fast:    150ms;   /* hover glow, crossfades */
  --dur-std:     250ms;   /* small state changes w/ --ease-ca */
  --dur-switch:  250ms;
  --delay-spin:  250ms;   /* spinner only appears for work >250ms */
}

@media (prefers-color-scheme: dark){
  :root{
    --bg-window:    #1E1E1E;
    --bg-canvas:    #161617;
    --bg-3d-top:    #2C2C2E;
    --bg-3d-mid:    #1F1F21;
    --bg-3d-edge:   #161618;
    --bg-underpage: #1A1A1C;
    --bg-field:     rgba(255,255,255,.08);

    --label:   rgba(255,255,255,.85);
    --label-2: rgba(255,255,255,.55);
    --label-3: rgba(255,255,255,.25);
    --label-4: rgba(255,255,255,.10);

    --fill:   rgba(255,255,255,.10);
    --fill-2: rgba(255,255,255,.08);
    --fill-3: rgba(255,255,255,.05);
    --fill-4: rgba(255,255,255,.03);
    --fill-pressed: rgba(255,255,255,.18);
    --slider-track: rgba(255,255,255,.14);
    --separator: rgba(255,255,255,.10);

    --accent:      #0091FF;
    --red:         #FF4245;
    --orange:      #FF9230;
    --green:       #30D158;
    --text-red:    #FF6165;
    --text-orange: #FFA056;
    --text-green:  #4AD968;
    --focus-ring:  rgba(26,169,255,.50);
    --selection:   #3F638B;

    --glass-lg-bg:     rgba(40,40,44,.62);
    --glass-lg-filter: blur(30px) saturate(170%);
    --glass-lg-rim:    inset .5px 0 0 rgba(255,255,255,.10);
    --glass-lg-edge:   inset .5px 0 0 0 rgba(255,255,255,.12);

    --glass-sm-bg:     rgba(255,255,255,.10);
    --glass-sm-filter: blur(16px) saturate(160%) brightness(1.06);
    --glass-sm-rim:    inset 0 0 0 .5px rgba(255,255,255,.16), inset 0 1px 0 rgba(255,255,255,.14);
    --glass-sm-shadow: 0 6px 20px rgba(0,0,0,.35), 0 0 0 .5px rgba(0,0,0,.30);
    --glass-illum:     rgba(255,255,255,.14);

    --shadow-thumb: 0 .5px 1px rgba(0,0,0,.45), 0 2px 5px rgba(0,0,0,.35);
    --shadow-pill:  0 1px 2px rgba(0,0,0,.35), inset 0 0 0 .5px rgba(255,255,255,.08);
  }
}
```

### Base

```css
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{font:var(--t-body);color:var(--label);background:var(--bg-window);
  -webkit-font-smoothing:antialiased;font-optical-sizing:auto;cursor:default;
  -webkit-user-select:none;user-select:none}
#upMsg, .subtitle{-webkit-user-select:text;user-select:text}
::selection{background:var(--selection)}
:focus{outline:none}
:focus-visible{outline:3px solid var(--focus-ring);outline-offset:1px}
.num{font-variant-numeric:tabular-nums}
```

### Accessibility and state overrides

```css
@media (prefers-contrast: more){
  :root{ --label-2: rgba(0,0,0,.70); --separator: rgba(0,0,0,.30);
         --glass-lg-bg: rgba(246,246,248,.97); --glass-sm-bg: rgba(255,255,255,.95); }
  .glass{ -webkit-backdrop-filter:none; backdrop-filter:none; box-shadow: inset 0 0 0 1px rgba(0,0,0,.5) }
}
@media (prefers-contrast: more) and (prefers-color-scheme: dark){
  :root{ --label-2: rgba(255,255,255,.75); --glass-lg-bg: rgba(36,36,40,.97); --glass-sm-bg: rgba(44,44,48,.95); }
  .glass{ box-shadow: inset 0 0 0 1px rgba(255,255,255,.5) }
}
@media (prefers-reduced-transparency: reduce){   /* Chromium only; Safari is covered by prefers-contrast */
  .glass{ -webkit-backdrop-filter:none; backdrop-filter:none; background: var(--bg-window) }
}
@media (prefers-reduced-motion: reduce){
  *{ transition-duration: 150ms !important; transition-timing-function: linear !important; animation-duration: 1ms }
  .spinner{ animation-duration: 1s !important }   /* keep progress visible */
  /* no scale/bounce: transforms on press are removed, crossfades only */
}
/* Inactive window: additive JS toggles html.inactive on window blur/focus */
html.inactive .glass{ --glass-sm-rim: none; --glass-lg-rim: none }
html.inactive .toolbar, html.inactive .inspector-body, html.inactive .legend { opacity:.6 }
html.inactive #exp:not(:disabled){ background: var(--fill); color: var(--label) }   /* accent recedes */
html.inactive input[type=range]{ --fill-color: var(--label-3) }                      /* slider fill grays out */
```

---

## 3. Component specs

### 3.0 Glass recipe (`.glass`, used only on: `.inspector`, `.viewer-capsule`, `.legend`)

```css
.glass{ -webkit-backdrop-filter:var(--glass-sm-filter); backdrop-filter:var(--glass-sm-filter);
  background:var(--glass-sm-bg); box-shadow:var(--glass-sm-rim), var(--glass-sm-shadow);
  border-radius:var(--r-capsule); position:relative; isolation:isolate }
/* pointer illumination (small glass only): additive JS sets --mx/--my on pointermove */
.glass.interactive::after{ content:""; position:absolute; inset:0; border-radius:inherit; pointer-events:none;
  background:radial-gradient(90px circle at var(--mx,50%) var(--my,50%), var(--glass-illum), transparent 65%);
  opacity:0; transition:opacity var(--dur-fast) var(--ease-ca) }
.glass.interactive:hover::after{ opacity:1 }
```
- Never place a `.glass` element inside another `.glass` element. Anything sitting on glass uses `--fill*` and label colors.
- No lensing or SVG displacement. Safari can't do it, and a faked version reads as cheap.
- Keep backdrop-filter to three or fewer elements on screen. Don't use `will-change` on any of them.

### 3.1 Toolbar band (`header.toolbar`, inside the content column)
- `height:var(--bar-h); padding:0 20px; display:flex; flex-direction:column; justify-content:center; background:var(--bg-canvas)`. It has no border. It is the same surface as the panes, so there is no divider line.
- Title: `<h1 class="title">Tool Studio</h1>`, `font:var(--t-title3); letter-spacing:var(--track-title3); color:var(--label); margin:0`.
- Subtitle: `<div class="subtitle num">` with `font:var(--t-subhead); color:var(--label-2)`. Markup:
  `<b id="cells">–</b> grid · Pocket <b id="pdim">–</b> · Bin <b id="bdim">–</b>`. The `b` elements use `font-weight:500; color:var(--label)`. The script already puts "mm" in `#pdim` and `#bdim`. "grid" follows `#cells` as plain text.

### 3.2 Inspector (`aside.inspector.glass`)
- `grid-column:2; grid-row:1 / -1; width:var(--inspector-w); height:100vh; border-radius:0; background:var(--glass-lg-bg); backdrop-filter:var(--glass-lg-filter); box-shadow:var(--glass-lg-edge), var(--glass-lg-rim); display:flex; flex-direction:column; overflow:hidden`. Behind it, the body shows `--bg-underpage` blending into the 3D backdrop (see 3.10). This gives the glass something to sample.
- Large panels do not flip light/dark with the content. They only follow `prefers-color-scheme`.
- **Header** (`.inspector-header`): `height:var(--bar-h); flex:none; display:flex; align-items:center; justify-content:flex-end; padding:0 var(--sp-2)`. It holds only `#exp`. The 8 px inset puts a 36 px capsule concentric with the 52 px band.
- **Body** (`.inspector-body`): `flex:1; overflow-y:auto; padding:4px 0 24px; overscroll-behavior:contain`.
  Soft scroll edge, active only while `scrollTop>0` (additive JS toggles `.scrolled`):
  `.inspector-body.scrolled{ -webkit-mask-image:linear-gradient(to bottom,transparent 0,#000 20px); mask-image:linear-gradient(to bottom,transparent 0,#000 20px) }`. No divider line under the header.
- **Section header** (`h2.section`): `font:var(--t-headline); color:var(--label); margin:16px 24px 6px; text-transform:none; letter-spacing:0`. Use sentence case. The first section uses `margin-top:8px`.
- **Card** (`.card`): `margin:0 var(--card-inset); background:var(--fill-3); border-radius:var(--r-card); padding:0 var(--card-pad-x)`. A card is a flat fill, not glass, with no border and no shadow.
- **Row** (`.row`): `position:relative; min-height:var(--row-h); display:flex; align-items:center; justify-content:space-between; gap:8px`. Separator: `.row + .row::before{content:"";position:absolute;top:0;left:0;right:0;height:var(--hairline);background:var(--separator)}`. Because rows sit inside the card's 12 px padding, the hairline is inset 12 px on both sides automatically.
- **Footer** (`.footer`, used by `#upMsg`): `font:var(--t-subhead); color:var(--label-2); margin:6px 24px 0; min-height:28px` (two lines). Status text may wrap.
- Row labels: `font:var(--t-body); color:var(--label)`. Use sentence case with no colon. In this stacked grouped-form style the label sits above the control like System Settings, so the colon convention for side-by-side labels doesn't apply.

### 3.3 Slider row (`.row.slider`), used for all 8 ranges

Markup pattern (ids unchanged; the `<b>` keeps id `xV`):
```html
<div class="row slider">
  <label for="clearance">Clearance</label>
  <output class="value num"><b id="clearanceV">2.5</b><span class="unit">mm</span></output>
  <input type="range" id="clearance" min="0" max="5" step="0.1" value="2.5">
</div>
```
- Layout: `display:grid; grid-template-columns:1fr auto; grid-template-rows:16px 20px; row-gap:6px; padding:9px 0 7px; min-height:var(--row-slider-h)`. The range spans both columns in row 2.
- Value: `font:var(--t-body); color:var(--label); text-align:right; min-width:56px`. `b` uses `font-weight:400`. `.unit` uses `color:var(--label-2); margin-left:3px`.
- **Units per control.** JS writes only the number, so the unit is a static `<span class="unit">` added by the markup:

  | id | range / step / default | value text (JS) | static unit span |
  |---|---|---|---|
  | `clearance` | 0–5 / 0.1 / 2.5 | `2.5` | `mm` |
  | `rot` | 0–90 / 1 / 0 | `0°` (JS adds °) | none (° already present; no space, per Apple style) |
  | `slotD` | 8–40 / 1 / 25 | `25` | `mm` |
  | `slotFrac` | 0–1 / 0.01 / 0.4 | `0.40` | none. A dimensionless fraction of tool length. The row label reads **Position** and the card footer explains it: "Slot position along the tool, from 0 to 1." |
  | `u` | 1–8 / 1 / 3 | `3U` (JS adds U) | none (U already present) |
  | `depth` | 3–40 / 0.5 / 10 | `10.0` | `mm` |
  | `fillet` | 0–6 / 0.25 / 3.18 | `3.25`* | `mm` |
  | `bfillet` | 0–4 / 0.25 / 0 | `0.00` | `mm` |

  *The browser snaps 3.18 to 3.25. That is existing behavior; keep it.
- **Track:** `input[type=range]{-webkit-appearance:none;appearance:none;width:100%;height:20px;background:transparent;margin:0;--p:50%;--fill-color:var(--accent)}`.
  `::-webkit-slider-runnable-track{height:6px;border-radius:3px;background:linear-gradient(to right,var(--fill-color) 0 var(--p),var(--slider-track) var(--p) 100%)}`.
  For Firefox use `::-moz-range-track` (same, with the unfilled part) plus `::-moz-range-progress{background:var(--fill-color);height:6px;border-radius:3px}`.
  `--p` is set by an additive JS listener: `el.style.setProperty('--p', (v-min)/(max-min)*100+'%')` on `input` and at load. It runs alongside the script's own listener and does not replace it.
- **Thumb (white lozenge):** `::-webkit-slider-thumb{-webkit-appearance:none;width:20px;height:16px;margin-top:-5px;border-radius:8px;background:#fff;box-shadow:var(--shadow-thumb);transition:transform var(--dur-release) var(--ease-snappy), background var(--dur-fast)}`. In dark mode the thumb is `#E6E6E6`. Mirror these values in `::-moz-range-thumb`.
- **Thumb while dragging (glass lift):** `input[type=range]:active::-webkit-slider-thumb{transform:scale(1.25);background:rgba(255,255,255,.35);box-shadow:inset 0 0 0 .5px rgba(255,255,255,.9), inset 0 1px 1px rgba(255,255,255,.8), 0 3px 10px rgba(0,0,0,.20)}`. The track fill shows through the knob. It springs back with `--ease-snappy` when released. Under reduced motion it gets no scale and only the background change.
- **Tick dots** (`#u` only: 8 values, and `#rot` at 0/15/…/90 for 7 dots): an absolutely positioned `.ticks` row under the track. Dots are 2×2 px, `border-radius:50%; background:var(--label-3)`, with `top:` 4 px below the track. The end dots are inset 10 px (half the thumb width), distributed with `justify-content:space-between`. The row grows by 6 px.
- No hover state. The arrow cursor stays.
- Live feedback: the value text and the 2D trace update on `input` with no transition (the script already does this). Discrete changes such as switches also get no animated geometry.
- **Finger-slot dependents:** `.card:has(#slotOn:not(:checked)) .row.slider{opacity:.5;transition:opacity var(--dur-std) var(--ease-ca)}`. They stay operable, because there is no `disabled` attribute and the script still reads them.

### 3.4 Switch rows (`#sym`, `#slotOn`; these replace the checkboxes)
They are still `<input type="checkbox">` with the same id and `checked` default. Add `role="switch"`. Do not add Safari's `switch` attribute, because the native rendering differs from Chrome's.
```html
<div class="row"><label for="sym">Symmetric tool</label><input type="checkbox" id="sym" role="switch"></div>
```
- `appearance:none; width:38px; height:22px; border-radius:var(--r-capsule); background:var(--fill); position:relative; margin:0; flex:none; transition:background var(--dur-switch) var(--ease-ca)`.
- Knob `::before`: `content:"";position:absolute;top:2px;left:2px;width:20px;height:18px;border-radius:9px;background:#fff;box-shadow:var(--shadow-knob);transition:transform var(--dur-switch) cubic-bezier(.3,.7,.4,1.2)`. This is a horizontal lozenge.
- `:checked{background:var(--accent)}` and `:checked::before{transform:translateX(14px)}`.
- `:active::before{width:24px}`, so the knob stretches toward its travel direction (and `:checked:active::before{transform:translateX(10px)}`).
- The whole row label is clickable via `for`.
- Labels and help: **Symmetric tool**, with the footer line under the Tool card explaining it. Note that `#upMsg` occupies the footer, so the symmetric hint goes into the switch row's `title` instead: "Mirror the outline for a clean, even cutout". **Grab slot** is the first row of the Finger slot card.

### 3.5 Pop-up (`#tool`, which stays a `<select>`; the script fills its `<option>`s)
- Row: `<label for="tool">Tool</label>` on the left, then the select, `max-width:170px; flex:0 1 170px`.
- `appearance:none; height:var(--ctl-h); padding:0 26px 0 9px; border:0; border-radius:var(--r-control); background:var(--fill) url(chevron) no-repeat right 8px center / 8px 12px; color:var(--label); font:var(--t-body); text-overflow:ellipsis`.
- The chevron is an inline SVG data URI of `chevron.up.chevron.down` (two 1.5 px stroked chevrons). Use stroke `rgba(0,0,0,.6)` in light mode and `rgba(255,255,255,.7)` in dark mode, with separate URIs in the dark media query.
- `:active{background-color:var(--fill-pressed)}`. No hover change. The OS menu is kept.

### 3.6 Upload button (`#upBtn`, bordered push button)
- Label: **Upload Photo…** (title case plus an ellipsis, because it opens the file dialog).
- Its row spans the full card width: `<div class="row"><button class="btn" id="upBtn">Upload Photo…</button></div>`, with the button `width:100%`.
- `.btn{height:var(--ctl-h);padding:0 12px;border:0;border-radius:var(--r-control);background:var(--fill);color:var(--label);font:var(--t-body);display:inline-flex;align-items:center;justify-content:center;gap:6px}`. `:active{background:var(--fill-pressed)}`. No hover. `:disabled{color:var(--label-3)}`.
- **Busy state:** `#upBtn:disabled::before`, a 12 px `.spinner` (see 3.11) placed before the label. While disabled the label reads dimmed. The script sets `#upMsg` to "Finding calibration sheet and tracing the tool…", which serves as the specific progress copy.
- `#upFile` stays `<input type="file" accept="image/*">`, hidden via `hidden` or `display:none`.

### 3.7 Prominent button (`#exp`, **Export STL**)
- The only tinted control. It sits in the inspector header.
- `height:var(--ctl-h-xl); padding:0 18px; border:0; border-radius:var(--r-capsule); background:color-mix(in srgb, var(--accent) 92%, transparent); color:var(--label-on-accent); font:var(--t-body-em); display:inline-flex; align-items:center; gap:6px; box-shadow: inset 0 1px 0 rgba(255,255,255,.28), inset 0 0 0 .5px rgba(255,255,255,.18), 0 2px 8px color-mix(in srgb, var(--accent) 30%, transparent)`. It has no backdrop-filter of its own, because it is a tinted fill on the inspector glass rather than glass on glass.
- Leading 15 px `square.and.arrow.up` SVG icon (stroke 1.6, `currentColor`), then the text "Export STL".
- Press: `:active{transform:scale(.97);filter:brightness(.92);transition:transform var(--dur-press) ease-out}` and on release `transition:transform var(--dur-release) var(--ease-press)`, which is the macOS 27 bounce. This and the viewer capsule are the only two places that bounce.
- `:disabled` (the initial state until the first generate): `background:var(--fill); color:var(--label-3); box-shadow:none; transform:none`.
- Tooltip `title="Save the bin as an STL file"`.

### 3.8 `#gen` (secondary icon button) and the viewer capsule
- `.viewer-capsule.glass.interactive`: `position:absolute; top:12px; right:12px; height:36px; padding:4px; display:flex; align-items:center; gap:2px; z-index:5`.
- `#gen`: `width:28px; height:28px; border-radius:14px` (concentric: 36/2 − 4), `border:0; background:transparent; color:var(--label); display:grid; place-items:center`. Inline SVG `arrow.clockwise`, 15 px, stroke 1.6. `aria-label="Refresh preview"`, `title="Regenerate the 3D preview"`. Hover: `background:var(--fill-3)`, since glass items do react to hover. Active: `background:var(--fill); transform:scale(.94)`, released with `--ease-press`.
- The capsule labels stay monochrome. If the backdrop is very light or very dark, small glass adapts via the light/dark tokens; there is no per-pixel flip.

### 3.9 Status: `#spin` (3D generation indicator)
- Lives inside `.viewer-capsule`, before `#gen`. The script toggles `style.display` between `'grid'` and `'none'`, so the CSS must render correctly under `display:grid` and must not set `display` with `!important`. Default CSS is `display:none`.
- `#spin{grid-auto-flow:column;align-items:center;gap:6px;padding:0 6px 0 8px;font:var(--t-subhead);color:var(--label-2);animation:spin-in 200ms var(--delay-spin) var(--ease-ca) both}`, with `@keyframes spin-in{from{opacity:0;filter:blur(3px)}to{opacity:1;filter:none}}`. The delay keeps it from flickering during the frequent 400 ms debounced regenerations.
- Content: `<span class="spinner"></span>Updating`. The text is static and the script never writes to it.
- No full-pane overlay and no dimming of the 3D view. The previous mesh stays visible and interactive while the new one builds.

### 3.10 Canvas frames
- **Stage** (`main.stage`): `grid-column:1; grid-row:2; display:grid; grid-template-columns:1fr var(--hairline) 1fr` (a 0.5 px divider element, `background:var(--separator)`). `@media (max-width:1100px){grid-template-columns:1fr; grid-template-rows:1fr var(--hairline) 1fr}`.
- **Pane** (`section.view`): `position:relative; overflow:hidden; min-width:0; min-height:0`.
  - **Constraint:** each canvas must fill its direct parent exactly, with no padding on that parent. `fit()` and `size3()` size the canvas buffer from `parentElement.getBoundingClientRect()`. Captions and chips are absolutely positioned siblings. `#flat, #three{position:absolute; inset:0; width:100%; height:100%; display:block}`.
- **Trace pane:** `background:var(--bg-canvas)`. Caption `.caption` "Trace": `position:absolute; top:12px; left:16px; font:500 11px/14px var(--font); color:var(--label-2); z-index:5; pointer-events:none`.
- **3D pane:** `background:radial-gradient(ellipse 80% 70% at 50% 40%, var(--bg-3d-top) 0%, var(--bg-3d-mid) 60%, var(--bg-3d-edge) 100%)`. The WebGL canvas is transparent. Caption "Preview".
- **Background extension:** the `body` background behind the inspector is `linear-gradient(to right, var(--bg-3d-edge), var(--bg-underpage))`, so the inspector glass samples a continuation of the 3D backdrop rather than flat white or black.
- **Photo in the trace** (inside `drawFlat`): clip the photo to a rounded rect, `fctx.roundRect(x,y,w,h, 8*devicePixelRatio)` → `clip()`, before `drawImage`. Keep `globalAlpha=.92` and all geometry math unchanged. No border and no shadow on the photo.

### 3.11 Loading indicator (`.spinner`)
- A 12-spoke spinner as one element: `width:14px;height:14px;` with a `background: conic-gradient(...)` mask, or (preferred) an inline SVG of 12 rounded spokes (2×4.5 px, `stroke-linecap:round`) colored `currentColor` with opacities stepping from 1 to .15. Use `animation:spin 1s steps(12) infinite`. 14 px in the capsule, 12 px in `#upBtn`. Never show a progress bar here, since the duration is unknown.

### 3.12 Overlay legend (`.legend.glass`, trace pane)
- `position:absolute; left:12px; bottom:12px; height:28px; padding:0 12px; display:flex; align-items:center; gap:12px; font:var(--t-subhead); color:var(--label); z-index:5`. Regular small glass. It sits over the neutral `--bg-canvas`, not over the photo, so clear glass and a dimming layer aren't needed.
- Items: **Tool** uses a line swatch `width:14px;height:2px;border-radius:1px;background:var(--trace-tool)`. **Pocket** uses a filled swatch `width:12px;height:9px;border-radius:2px;background:color-mix(in srgb,var(--trace-pocket) 14%,transparent);box-shadow:inset 0 0 0 1.5px var(--trace-pocket)`. Shape differs as well as color (line versus filled region), so color isn't the only cue. Remove the inline `style` hex colors.

### 3.13 2D trace drawing (`drawFlat`)
- Read the colors once per draw: `const cs=getComputedStyle(document.documentElement); const cTool=cs.getPropertyValue('--trace-tool').trim(), cPocket=cs.getPropertyValue('--trace-pocket').trim();`.
- Pocket: halo first (`lineWidth = 4*dpr`, `rgba(255,255,255,.65)`), then fill `color-mix`-equivalent `rgba(R,G,B,.12)` (keep the existing `.14`), then stroke `cPocket` at `2*dpr`.
- Tool: halo `3.5*dpr` white at .7, then stroke `cTool` at `1.6*dpr`. Use `lineJoin='round'`.
- Note: the current code uses device-pixel line widths of 2 and 1.6 without dpr. Multiplying by `devicePixelRatio` is optional. If you do it, apply it uniformly.
- Redraw on `matchMedia('(prefers-color-scheme: dark)').addEventListener('change', drawFlat)`.

### 3.14 3D viewer look (Quick Look product shot; 3D setup and `showSTL`)
- Renderer: `new THREE.WebGLRenderer({canvas:tc, antialias:true, alpha:true})`, `renderer.setClearColor(0x000000, 0)`, `scene.background = null` (the CSS gradient shows through), `renderer.outputColorSpace = THREE.SRGBColorSpace`, `renderer.toneMapping = THREE.ACESFilmicToneMapping`, `toneMappingExposure = 1.0`.
- Environment: `import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'`, then `scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture`. Remove the blue-tinted HemisphereLight. Keep one `DirectionalLight(0xffffff, 0.8)` from above and front at `(0.4R, 2R, 0.6R)` with `castShadow`, and no visible helpers.
- Bin material: `MeshStandardMaterial({color: light 0xD9D9DE / dark 0xA7A7AD, roughness:.6, metalness:0})`, a matte neutral PLA look. No blue tint, because the accent is reserved for the UI. Swap the color on the color-scheme change.
- **Grounding shadow:** a `PlaneGeometry` at the bin's base, `ShadowMaterial({opacity: light .16 / dark .35})`. Use `renderer.shadowMap.enabled=true; type=PCFSoftShadowMap`, `light.shadow.mapSize.set(2048,2048)`, `light.shadow.radius=8`, with the shadow camera fitted to 1.5× the bin footprint. `mesh.castShadow=true`. Alternative with no shadow maps: a plane with a canvas-generated radial texture (center `rgba(0,0,0,.28)`, transparent at 1.1× the footprint).
- **Ground position fix:** `geo.center()` puts the bin's base at `−height/2`, but the current grid sits at y=−0.2 and cuts through the bin. In `showSTL`, after rotating, call `new THREE.Box3().setFromObject(mesh)` and set `ground.position.y = grid.position.y = box.min.y - 0.1`.
- **Baseplate grid (product-meaningful, very subtle):** replace `GridHelper(420,10,…)` with 42 mm cells (one gridfinity unit), `GridHelper(42*12, 12)`. Its material is `transparent:true, opacity: light .10 / dark .12`, colored `label` black or white, with no colored axis lines. Fade it out radially with `onBeforeCompile` alpha falloff by about 2.5× the footprint, or keep it at a fixed low opacity. There is no axis gizmo. This is the one exception to "no grid in viewer mode", because the 42 mm grid carries meaning for gridfinity.
- Camera: `fov 30`. In `showSTL`, `dist = R / Math.sin(fov/2 in rad) * 1.15`, and set the camera position along the normalized vector (1.6, 1.5, 1.9)·dist. The target is the bounding-box center, so the bin fills about 75% of the viewport.
- Controls: `enableDamping=true; dampingFactor=.08; rotateSpeed=.8; zoomSpeed=.9; minPolarAngle=.15; maxPolarAngle=Math.PI/2-.05` (never under the floor). `screenSpacePanning=true`. No auto-rotate.
- Reduced motion: `dampingFactor=1` (no inertia).
- The scene must never show a blank pane. Before the first mesh arrives, the gradient backdrop and the ground shadow plane (unscaled) are already visible.

### 3.15 Presentation JS
Small presentation-only listeners, kept separate from the app logic:
1. Slider `--p` sync on `input` and at load, for all 8 ranges.
2. `html.inactive` toggled on `window` `blur`/`focus`.
3. `.inspector-body.scrolled` toggled on `scroll` (`scrollTop>0`).
4. `--mx`/`--my` set on `pointermove` for `.glass.interactive`.
5. The color-scheme `change` listener for the 3D material and ground colors and for `drawFlat` (it must live inside the main module to reach `mat` and `scene`).

---

## 4. Do / Don't (web pitfalls that make it a fake Apple clone)

**Do**
- Use SF via `-apple-system, system-ui`: 13 px body, 11 px footers, a 15 px semibold title, and nothing larger.
- Use alpha-black or alpha-white label colors (85/50/26%), not opaque grays like #666 or #999.
- Use `font-variant-numeric: tabular-nums` on every value, with the unit as a separate secondary-colored span.
- Use one tinted capsule (Export STL). Everything else is a monochrome fill or a borderless glyph.
- Use rounded-rect 24 px controls (radius 6) in the inspector. Capsules are only for glass groups, switches and the 36 px primary button.
- Keep radii concentric: capsule 36 with 4 px padding gives an inner 28 px button with radius 14. Cards are 12 and controls 6.
- Keep sections as flat `--fill-3` cards with 0.5 px inset hairlines between rows, and no box borders.
- Use the macOS 26 colors: blue #0088FF/#0091FF, red #FF383C/#FF4245, white/#1E1E1E window.
- Show the arrow cursor, no hover on bordered controls, and focus rings only on `:focus-visible`.
- Honor prefers-color-scheme, prefers-contrast, prefers-reduced-transparency and prefers-reduced-motion, and dim when the window is inactive.
- Let the trace and 3D update immediately while sliders move. Show the spinner inline and only after 250 ms.

**Don't**
- Don't use uppercase, letter-spaced section labels ("POCKET", "TRACE — PHOTO & OUTLINE"). Use sentence case: "Pocket", "Trace".
- Don't put glass on content: no frosted cards, no frosted canvases, no glass inside the inspector, and no glass on glass.
- Don't use 2020 glassmorphism: no white-25% fills, 1–2 px white borders, colored gradient blobs or decorative orbs.
- Don't use solid saturated buttons in two colors (the old blue Generate plus green Export), and don't use more than one tinted button.
- Don't use round accent-colored slider thumbs with rings. The thumb is a white lozenge, 20×16.
- Don't use 1 px dividers between toolbar and content or between inspector sections. Use spacing and the scroll edge effect.
- Don't use fake traffic lights, window chrome, or a centered max-width "card on gray" page layout.
- Don't use the pointer (hand) cursor, hover glows on bordered buttons, or bold control labels.
- Don't use a full-pane "generating…" overlay, and don't dim the 3D view while working.
- Don't use the Three.js default look: hemisphere blue light, saturated grid axes, hard shadow-map edges, glossy plastic, or orbiting below the floor.
- Don't use pure #0000FF or #FF0000 outlines at 1 px without a halo, and don't rely on color alone in the legend.
- Don't apply manual letter-spacing to 10–13 px text (CoreText already tracks it in Safari).
- Don't fake lensing with static gradient "reflections" or chromatic fringes.
- Don't use more than three backdrop-filter elements over the live WebGL canvas, and don't stack them.
- Don't use iOS sizes (17 px body, 44 px rows, 34 px titles).

---

## 5. UI contract

The script depends on these ids and variables; keep them when changing the markup or CSS.

1. **Every id survives with the same element type and semantics:**
   - `<select id="tool">`. The script fills its options; keep it empty in the markup.
   - `<button id="upBtn">`, `<input type="file" id="upFile" accept="image/*">` (hidden), `<div id="upMsg">` (text-only content; the script overwrites `textContent` and `style.color`).
   - `<input type="checkbox" id="sym">` (unchecked) and `<input type="checkbox" id="slotOn" checked>`. They are still checkboxes, styled as switches with `role="switch"`.
   - `<input type="range">` with **unchanged** min/max/step/value: `clearance` 0/5/0.1/2.5, `rot` 0/90/1/0, `slotD` 8/40/1/25, `slotFrac` 0/1/0.01/0.4, `u` 1/8/1/3, `depth` 3/40/0.5/10, `fillet` 0/6/0.25/3.18, `bfillet` 0/4/0.25/0.
   - Value outputs `clearanceV, rotV, slotDV, slotFracV, uV, depthV, filletV, bfilletV` (elements whose `textContent` the script sets; units live in sibling spans, never inside them).
   - `<button id="gen">`, `<button id="exp" disabled>` (it must start disabled).
   - `#cells, #pdim, #bdim` (text-only).
   - `<canvas id="flat">`, `<canvas id="three">`. Each is the sole sizing child of an unpadded parent that has a definite size.
   - `#spin`: works when the script sets `style.display='grid'`/`'none'`. CSS default is `display:none`. Its children may be static markup.
2. **CSS variables used by the script stay defined:** `--muted`, `--accent2`, `--ok`.
3. Markup and CSS may be restructured freely within the above. The `.tag`, `.legend`, `.grp`, `.cta` and `.stat` classes have no script dependency and can be renamed or removed.
