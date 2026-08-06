# Screenshot autocrop

Status: **specified, not built.** Written against HEAD `abca603`, clean tree.
Backlog item 1 of the 2026-08-03 owner list (`docs/HANDOFF.md`, "Backlog —
added 2026-08-03"). Builder: implement exactly what is ruled here; where this
document is silent, the existing capture path's behaviour stands unchanged.

What this adds: a capture is trimmed to the meaningful region instead of filing
the whole viewport. Two modes, one seam, one failure direction:

- **Auto-trim** (default, both call sites): strip uniform-colour margins from
  the frame, in pixel space, with no reference to any engine state. Cannot
  remove visible content by construction.
- **Detail crop** (agent only, explicit): `browser_capture` gains a `crop`
  parameter naming a ref; the shot is cropped to that element plus padding.
  Can hide things by design, so it is loudly annotated and declines to the
  full frame in every case where something on screen may need seeing.

Every crop is recorded in the Notion caption as an Aperture-authored,
closed-alphabet note (`trimmed 812×334 of 1280×800`), so a cropped record can
never masquerade as a full one. When anything is uncertain, the full frame is
filed. Losing a screenshot remains the worst outcome (`routeCapture`'s own
doctrine); filing a *misleadingly partial* one is the second worst, and this
design treats it that way.

---

## 1. What defines the crop region — ruling and why the others lose

Four candidates were on the table. Ruled: **(c) detected content bounds** as
the automatic default, **(d) an explicit caller-named ref** as the only
narrowing mechanism. (a) and (b) lose as automatic policies.

**(a) The element the agent just acted on — loses.** The acted element is the
*cause*, not the evidence: the interesting consequence of a click — the dialog
it opened, the error banner it raised, the row it deleted — is usually
somewhere else on the page. A crop centred on the button that was pressed is a
picture of the least informative pixels on the screen. It also does not exist
on the human path (the toolbar button has no acted element), so adopting it
would force the two paths apart for no gain. Everything legitimate about this
candidate survives inside (d): an agent that wants the acted element files
`crop: <its ref>` and says so in the transcript.

**(b) The region that changed since the last observation — loses.** The diff
engine does know the changed refs, and the registry carries a viewport rect
for every one (`RefEntry.rect`, `src/core/snapshot/registry.ts` via
`walker.ts`'s `rectOf`). It is still the wrong crop authority, for five
reasons that do not improve with effort:

1. The diff is **semantic, not visual** (`diffSnapshots` compares roles,
   names, values, states, rows). A purely visual change — a CSS class swap, an
   image load, a canvas repaint — produces no op, so the "changed region" would
   be empty exactly when the screenshot is most wanted.
2. **Removed content has no rect to crop to.** A `remove`/`gone` op names refs
   whose elements are gone; the region where something *disappeared* is the
   evidence, and nothing addressable bounds it.
3. **Scatter.** A counter in the header plus a row in a list is two rects whose
   union box approaches the full viewport; the crop degenerates precisely on
   busy pages.
4. **Staleness.** Registry rects are walk-time viewport coordinates. Diffs are
   consumed on every act; by capture time the last diff is often `unchanged`
   and the rects predate any scroll since. A crop computed from them silently
   frames the wrong pixels.
5. **It does not exist on the human path.** `stateFor(tabId)` is the *agent's*
   page model; the human's toolbar button has no observation baseline, so the
   two paths would diverge on identical page state — the exact property §2
   rules out.

**(c) Detected content bounds — wins as the default.** Pure pixel-space, a
deterministic function of the captured frame alone: same frame, same crop,
whoever asked. It needs no engine state, works identically for both call
sites, and its failure direction is inherently safe — it can only remove
pixels that match the background within tolerance, and anything a human needed
to see is, by the fact of being visible, not background (§3).

**(d) An explicit ref — wins as the only narrowing lever.** The caller that
can name a region is the agent, it names it in a transcript-visible parameter,
and responsibility for the framing is the caller's. Aperture still refuses it
whenever the screen may contain something the record needs (§3).

## 2. Who decides — Aperture defaults, the agent may narrow, the human never diverges

- **Aperture decides the default.** Auto-trim is a deterministic function of
  the rendered pixels, so the human and the agent get byte-identical framing
  for the same page state. Nothing hidden — no engine state, no model state —
  participates in the default crop.
- **The agent may narrow, only explicitly.** `crop` is a new agent-controlled
  parameter on `browser_capture`. It is visible in the transcript, echoed in
  the tool reply, and recorded in the caption, so a narrowed record is
  attributable and auditable. There is no implicit narrowing of any kind.
- **The human gets no narrowing lever** in this iteration. The toolbar button
  stays one-click ("keep this"), and auto-trim only removes provably-empty
  margin from what they were looking at. A human crop picker is UI work that
  is out of scope (§10) and, unlike the agent's, cannot be captured in a
  transcript.
- `crop: "none"` files the untouched full frame, for the case where the agent
  (or a human directing it) wants margins preserved — e.g. filing evidence of
  layout itself.

## 3. Can a crop hide something the human needed to see — the failure-safe rules

A screenshot filed to Notion is a record. A crop that trims away the consent
dialog, the error banner, or the rest of the form is worse than no crop.
Ruling, per mode:

**Auto-trim cannot hide visible content, by construction.** It removes only
rows/columns in which *every* pixel matches the frame's own background colour
within tolerance. A consent dialog, a banner, a form — anything rendered — is
non-background and therefore inside the retained bounds. The residual it *can*
remove is the fact of emptiness itself (a mostly-blank page trims to its one
small box). That fact is preserved numerically: the caption note carries both
the trimmed and the original dimensions, so "812×334 of 1280×800" states
exactly how much emptiness was cut. Auto-trim therefore never declines for
safety reasons — only for applicability (no uniform background, nothing saved,
processing invariant failed), and those declines are silent: the full frame is
filed and the absence of a note is the honest record.

**Detail crop can hide things — that is its purpose — so it must decline to
the full frame** whenever the screen may contain something the record needs.
Closed decline list; every entry files the full untrimmed frame and tells the
agent why (§7.4 vocabulary):

| condition | why the full frame is the answer |
|---|---|
| `crop` is not `none` and not `/^e\d+$/`, or the ref is unknown | nothing trustworthy to frame |
| the ref is dead (`refEntry(...).state === 'dead'`) | the element left the page; the current screen is the story |
| the last snapshot records a modal (`stateFor(id).last?.modal`) | **the consent-dialog case, literally.** Something is demanding attention; the record must show it. Declined even when the crop target is the modal itself — the full frame also shows the modal, and one rule with no carve-outs survives review |
| `resolveRef` fails (`gone`, `not-visible`, timeout) | live geometry unavailable; do not frame from stale rects |
| `resolveRef` reports `obstructed` | something covers the target — an overlay the crop would slice through |
| the target is in a subframe (`refEntry(...).frameId !== 0`) | the preload's rect is subframe-relative; cropping the top-level frame with it frames the wrong pixels |
| the target is smaller than 24×24 CSS px pre-pad, or the padded rect clamps to nothing | too small to be a real detail shot; the hidden-trap intuition from the fill path |
| the padded rect covers ≥ 90% of the frame | the "crop" is the frame; file it as one |
| any processing invariant fails (§7.2) | when the math is in doubt, the pixels are not |

Two residuals, disclosed rather than closed:

- **A modal that opens after the agent's last observation** is invisible to
  the modal rule (the check reads the agent's model, deliberately — see §7.4
  for why capture must not run its own `observe()`). Whenever such a modal
  covers the crop target, `resolveRef`'s live obstruction check catches it
  anyway; a fresh modal that covers only *other* parts of the screen while a
  detail crop is filed is the residual. It is bounded by `browser_capture`'s
  existing restriction to agent-owned tabs.
- **Layout motion between resolve and capture** (an animation, a late reflow)
  can shift the target within the padded rect. The 16px pad absorbs the common
  case; the residual is a slightly off-centre detail shot, not a hidden one.

**The universal failure direction is the full frame.** No path in this feature
may fail toward a tighter crop, and no path may fail toward losing the
capture: every throw inside crop processing is caught and answered with the
full frame (§7.2).

## 4. Human vs agent paths — same seam, same default, one extra lever

Both call sites converge on one new choke point, `captureForFiling`
(§7.2), the way they already converge on `routeCapture`:

- **Human toolbar** (`capture:page`, `src/main/ipc.ts`): always
  `{ kind: 'trim' }`. Auto-trim only, no parameters, no UI change; the
  renderer's `✓ saved` / `✓ Notion` flow is untouched.
- **Agent** (`browser_capture`, `src/mcp/tools.ts`): `{ kind: 'trim' }` by
  default — identical to the human — plus the explicit `crop` parameter for
  `none` (full frame) or a ref (detail, subject to §3).

The asymmetry is exactly one lever, and it points the right way: the human is
looking at the screen and their one button means "keep what I see" — auto-trim
preserves that meaning. The agent is not looking at anything; when it wants a
tighter frame it must say so in words the transcript keeps. The agent-owned-tab
refusal on `browser_capture` and its deliberate absence on the human path are
unchanged (the ipc.ts comment explaining that carve-out stands as written).

## 5. Does the agent ever see the image — no, unchanged, and it bounds the feature

Capture files to Notion or disk; the image never enters agent context, and
autocrop does not change that. The tool reply remains text (destination,
size, and now dimensions and decline notes — all Aperture-authored). This
bounds the whole feature's risk:

- No image-borne prompt injection path opens, because no image reaches the
  model — the reason the tool files rather than returns stays valid verbatim.
- The `crop` parameter controls what is *filed*, not what the agent
  *observes*: it grants no new read capability whatsoever.
- A cropped upload is a **subset of pixels the full-frame capture already
  sent** to the same destination under the same token and the same
  agent-owned-tab refusal. Detail crop can change the emphasis of a record; it
  cannot disclose one byte that full-frame capture would not have.

## 6. Security posture — what this must not touch, and what it adds

**Not security work.** No sink hunting, no new mechanism classes, no reopening
the closed programme. The seven-class table in `security.md` and the
still-owed author-independent rows for classes C and D are untouched by this
feature and stay owed by their existing owners.

**Binding constraints on the implementation:**

1. **`routeCapture`'s three page-influenced arguments keep their exact
   treatment.** `title` through `redactFreeText`, `sourceUrl` through
   `redactUrl`, `openUrls` a one-element active-tab array, at both call
   sites. `test/urlsurfaces.test.ts` must pass **unmodified** — its
   `routeCapture` options-block regexes tolerate the one new `cropNote` line,
   and nothing in this feature gives cause to edit that file.
2. **`cropNote` is a new `RouteOptions` member and it is NOT page-influenced.**
   It is built by exactly one function, `cropNoteFor` (§7.1), from a validated
   ref (`/^e\d+$/`, Aperture-minted) and integers; its output alphabet is
   closed (`/^(trimmed|detail e\d+) \d+×\d+ of \d+×\d+$/`) and unit-asserted.
   No element label, no title fragment, no page-authored byte may ever reach
   it — an element's accessible name is page bytes and is deliberately NOT in
   the caption. The one new guard leg (§8) pins the producer and the call-site
   spelling so this stays true by test rather than by review.
3. **Honest disclosure, ruled acceptable:** the crop *dimensions* are
   page-influenced integers (the page's layout determines content bounds and
   element rects) and they leave the machine in the caption. A page could in
   principle signal a few bits per capture by sizing its content. The image
   travelling beside the caption already shows that same page in full fidelity
   to the same destination, so the numbers add nothing an adversary lacks.
   Ruled negligible; recorded so nobody rediscovers it as a finding.
4. **The egress inventory stays keyed.** `wc.capturePage()` remains in
   `src/capture/capture.ts`, argument-less, on a receiver annotated
   `wc: WebContents`, so `test/egress.test.ts`'s row
   `src/capture/capture.ts :: WebContents#capturePage` keeps matching and its
   ruling text stays true ("the IMAGE never enters agent context"). The new
   `src/capture/autocrop.ts` imports **no Electron value bindings** — the
   `NativeImage` type arrives as `import type` only — so it adds zero rows to
   the inventory's tracked surfaces. Do not move the `capturePage` call and do
   not give it an argument (cropping is done on the returned image, never via
   a capture rect).
5. **The preload change adds fields to an existing reply, not a channel.**
   `aperture:resolve`'s reply gains `rect`, `vw`, `vh` (§7.3) — numbers from
   `getBoundingClientRect`/`innerWidth` in the isolated world, flowing only
   into main-process crop math. No new IPC channel, no page-authored string.

## 7. Implementation

### 7.1 `src/capture/autocrop.ts` — new file, the pure core

No Electron value imports (type-only imports permitted). Everything here is
plain-data in, plain-data out, unit-testable under vitest without a runtime.

```ts
/** Viewport/bitmap rectangle. Structurally identical to core/snapshot's Rect;
 *  declared locally so capture/ keeps zero runtime coupling to the engine. */
export type Rect = [x: number, y: number, w: number, h: number];

/** BGRA (or RGBA — the math never names a channel), 4 bytes per pixel. */
export interface Bitmap { width: number; height: number; data: Buffer }

export type CropDecline =
  | 'no-uniform-background'  // corners disagree; nothing safely trimmable
  | 'blank-frame'            // no non-background pixel at all
  | 'savings-too-small'      // trim would save < MIN_TRIM_SAVINGS of area
  | 'region-too-small'       // detail rect < MIN_DETAIL_DIM pre-pad
  | 'region-is-frame'        // detail rect ≥ DETAIL_FULL_FRACTION of frame
  | 'processing-failed';     // invariant failed or an exception was caught

export const TRIM_TOLERANCE = 8;        // per channel, first three channels
export const TRIM_PAD = 16;             // bitmap px
export const DETAIL_PAD = 16;           // CSS px
export const MIN_TRIM_SAVINGS = 0.05;   // fraction of frame area
export const MIN_AUTO_DIM = 64;         // bitmap px, post-pad floor
export const MIN_DETAIL_DIM = 24;       // CSS px, pre-pad floor
export const DETAIL_FULL_FRACTION = 0.9;
```

`detectScale(byteLength: number, w: number, h: number): number | null` —
`sf = Math.sqrt(byteLength / (4 * w * h))`; accept iff
`Math.round(w * sf) * Math.round(h * sf) * 4 === byteLength` and `sf > 0`;
else `null`. (At the probed dpr 1, `toBitmap()` came back at exactly
`getSize()` × 4 bytes — §9. This function is what makes a HiDPI machine
degrade to a declined trim instead of corrupt math.)

`contentBounds(bmp: Bitmap): Rect | null` — tight bounds of non-background
content, in bitmap px:

1. Read the four corner pixels. Background candidate = the top-left corner.
   If any other corner differs from it by more than `TRIM_TOLERANCE` on any of
   the first three channels → `null` (no uniform background; full-bleed pages
   and content flush into a corner both land here, and both correctly file the
   full frame). The fourth channel (alpha) is ignored throughout.
2. A pixel is background iff all three channel deltas ≤ `TRIM_TOLERANCE`.
   A row/column is background iff every pixel in it is.
3. `top` = first non-background row from the top, `bottom` = last from the
   bottom; then `left`/`right` by column scan restricted to rows
   `[top, bottom]`. No non-background row → `null` (blank frame).
4. Return `[left, top, right - left + 1, bottom - top + 1]`.

`trimRect(bmp: Bitmap): { rect: Rect } | { declined: CropDecline }`:

1. `contentBounds`; `null` → declined (`no-uniform-background` if step 1
   failed, `blank-frame` if step 3 did).
2. Pad by `TRIM_PAD` on each side; clamp to `[0, 0, bmp.width, bmp.height]`.
3. Enforce `MIN_AUTO_DIM` per axis by symmetric expansion about the rect
   centre, clamped to the frame. (Expansion, not decline: monotone toward the
   full frame, never away from it.)
4. If `(frameArea - rectArea) / frameArea < MIN_TRIM_SAVINGS` → declined
   (`savings-too-small`).
5. `{ rect }` in bitmap px.

`detailRect(target: Rect, vw: number, vh: number): { rect: Rect } |
{ declined: 'region-too-small' | 'region-is-frame' }` — all CSS px:

1. `target[2] < MIN_DETAIL_DIM || target[3] < MIN_DETAIL_DIM` →
   `region-too-small`.
2. Pad by `DETAIL_PAD` each side; clamp to `[0, 0, vw, vh]`. Degenerate after
   clamp (w or h ≤ 0) → `region-too-small`.
3. Area ≥ `DETAIL_FULL_FRACTION * vw * vh` → `region-is-frame`.
4. `{ rect }` with `Math.floor` on origin and `Math.ceil` on extent
   (outward rounding: rounding error trims less, never more).

`cropNoteFor(kind: 'trimmed' | 'detail', ref: string | null, w: number,
h: number, fw: number, fh: number): string` — throws unless (`kind ===
'trimmed' && ref === null`) or (`kind === 'detail' && /^e\d+$/.test(ref)`);
all four dimensions must be positive integers or it throws. Returns exactly
`` `trimmed ${w}×${h} of ${fw}×${fh}` `` or
`` `detail ${ref} ${w}×${h} of ${fw}×${fh}` ``. Output matches
`/^(trimmed|detail e\d+) \d+×\d+ of \d+×\d+$/` for every non-throwing input —
this closed alphabet is the caption-channel guarantee of §6.2 and is asserted
as a property in the tests. The throw-on-bad-ref is deliberate: a caller that
reaches this function with an unvalidated ref has a bug, and a thrown error is
caught by `captureForFiling`'s catch-all into a full-frame filing, which is
the correct failure direction.

### 7.2 `src/capture/capture.ts` — the seam

**Remove `capturePage`** (returning a PNG Buffer) and add:

```ts
export type CaptureMode =
  | { kind: 'full' }   // untouched frame — `crop: "none"`, and every decline
  | { kind: 'trim' }   // auto-trim (the default, both call sites)
  | { kind: 'detail'; ref: string; rect: Rect; vw: number; vh: number };

export interface FilingCapture {
  bytes: Buffer;                    // PNG actually filed
  frame: { w: number; h: number };  // DIP dims of the full capture
  out: { w: number; h: number };    // dims of what was filed
  note?: string;                    // cropNoteFor output; set iff cropped
  declined?: CropDecline;           // set iff a crop was attempted and refused
}

export async function captureForFiling(
  wc: WebContents,
  mode: CaptureMode,
): Promise<FilingCapture>;
```

Behaviour (the whole body after the capture sits in one `try/catch`; any throw
returns the full frame with `declined: 'processing-failed'`):

1. `const img = await wc.capturePage();` — stays in this file, argument-less,
   `wc` annotated `WebContents` (§6.4). `frame = img.getSize()` (DIP).
2. `kind: 'full'` → `{ bytes: img.toPNG(), frame, out: frame }`.
3. `kind: 'trim'` → `const bmp = img.toBitmap()`; `detectScale(bmp.length,
   frame.w, frame.h)` — `null` → full frame, `declined: 'processing-failed'`.
   Build the `Bitmap` at the detected scale; `trimRect`; declined → full frame
   carrying the decline. Else map the bitmap-px rect to DIP by dividing by the
   scale (floor origin, ceil extent), `img.crop(dipRect)`, note =
   `cropNoteFor('trimmed', null, out.w, out.h, frame.w, frame.h)`.
4. `kind: 'detail'` → `detailRect(rect, min(vw, frame.w), min(vh, frame.h))`;
   declined → full frame carrying the decline. Else `img.crop(dipRect)`,
   note = `cropNoteFor('detail', mode.ref, out.w, out.h, frame.w, frame.h)`.
5. **Post-crop invariant, both modes:** `img.crop(...).getSize()` must match
   the requested dims within 2px per axis; otherwise full frame,
   `declined: 'processing-failed'`. (This is what makes the unverified HiDPI
   `crop` semantics of §9 harmless: wrong-scale cropping cannot ship a wrong
   image, only a full one.)
6. `bytes = cropped.toPNG()`; return with `note` and `out`.

`RouteOptions` gains one member, with this doc comment shape:

```ts
/** Aperture-authored crop annotation for the caption. Built ONLY by
 *  cropNoteFor — closed alphabet, never a page-authored byte. */
cropNote?: string;
```

and the caption line becomes:

```ts
const caption =
  (([opts.title, opts.sourceUrl].filter(Boolean).join(' — ') || filename) +
    (opts.cropNote ? ` · ${opts.cropNote}` : ''));
```

Nothing else in `routeCapture` changes: destination logic, fallback chain,
`fellBackBecause`, `toDisk` are untouched, and the scrub responsibilities of
the callers are exactly as before.

### 7.3 `src/preload/page.ts` and `src/core/snapshot/act.ts` — live geometry

The `aperture:resolve` reply (the handler at the "Resolve a ref's identity key
to a live rect" comment) already computes `r = el.getBoundingClientRect()`;
add to the success payload:

```ts
rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
vw: window.innerWidth,
vh: window.innerHeight,
```

`Resolved` in `act.ts` gains the same three as **optional** members
(`rect?: [number, number, number, number]; vw?: number; vh?: number`).
Optional is load-bearing: against a stale preload artifact the fields are
absent, and the tools.ts flow below treats absence as a decline
(`processing-failed`) rather than crashing or mis-cropping. Existing consumers
(`browser_act`, the fill pipeline) read `ok`/`x`/`y`/`obstructed` and are
unaffected. `resolveRef`'s `scrollIntoView` side effect is *intended* here: a
detail capture of an off-screen element means "bring it on screen and shoot
it", which is what a human would do.

### 7.4 `src/mcp/tools.ts` — `browser_capture`

Schema adds one key:

```ts
crop: z.string().optional().describe(
  'Crop the filed image to this element ref (eN) plus padding, or "none" to ' +
  'file the untouched full frame. Absent: empty margins are trimmed ' +
  'automatically. Declines to the full frame rather than guess; the image ' +
  'is still filed, never returned to you.'),
```

Handler flow, replacing the `capturePage` call (everything else in the
handler — the agent-owned refusal, the three scrubbed `routeCapture`
arguments, the `fellBackBecause` treatment — is byte-for-byte unchanged):

```ts
/** Tool-level decline union: the pre-capture refusals this handler decides,
 *  plus the three capture-level declines a detail request can surface.
 *  The auto-only CropDecline values (no-uniform-background, blank-frame,
 *  savings-too-small) are deliberately NOT here — auto-trim declines are
 *  silent (§3), so they can never need prose. */
type CropDeclineReason =
  | 'unknown-ref' | 'ref-dead' | 'not-visible' | 'obstructed'
  | 'modal-open' | 'subframe'
  | Extract<CropDecline, 'region-too-small' | 'region-is-frame' | 'processing-failed'>;

const DECLINE_PROSE: Record<CropDeclineReason, string> = {
  'unknown-ref':      'unknown ref — refs come from browser_snapshot',
  'ref-dead':         'that element left the page',
  'not-visible':      'the element has no visible box',
  'obstructed':       'the element is covered by another element',
  'modal-open':       'a modal dialog is open; the full frame shows it',
  'subframe':         'the element is inside an embedded frame',
  'region-too-small': 'the region is too small',
  'region-is-frame':  'the region is effectively the whole frame',
  'processing-failed':'image processing failed',
};
```

(`Record` over a closed union, the `DENY_STRINGS` pattern: totality by
typecheck, and every string is Aperture's own — no interpolation slot exists,
so no page byte and no unvalidated agent byte can enter the reply. The
declined `crop` value is deliberately never echoed.)

1. `crop === 'none'` → mode `{ kind: 'full' }`. Absent → `{ kind: 'trim' }`.
2. Otherwise resolve, strictly in this order, first failure wins and the mode
   falls back to `{ kind: 'full' }` with the named decline:
   `/^e\d+$/` fails → `unknown-ref`; `refEntry(id, crop)` missing →
   `unknown-ref`, `state === 'dead'` → `ref-dead`, `frameId !== 0` →
   `subframe`; `stateFor(id).last?.modal` set → `modal-open`; then
   `agentTouched(id, key)` and `const r = await resolveRef(wc, key)`:
   `!r.ok` → `not-visible` when `reason === 'not-visible'`, else `ref-dead`;
   `r.obstructed` → `obstructed`; `r.rect`/`r.vw`/`r.vh` absent →
   `processing-failed`. Success → `{ kind: 'detail', ref: crop, rect: r.rect,
   vw: r.vw, vh: r.vh }`.
3. `const cap = await captureForFiling(t.webContents(id), mode);` then
   `routeCapture(cap.bytes, { openUrls: …, title: …, sourceUrl: …,
   cropNote: cap.note })` — the three existing arguments verbatim, and the
   new one spelled exactly **`cropNote: cap.note`** (the guard leg in §8
   matches this literally).
4. Reply, on the existing line:
   `` `captured ${KB}KB${cap.note ? ` (${cap.out.w}×${cap.out.h} of ${cap.frame.w}×${cap.frame.h})` : ''} · ${where}` ``
   plus, **only when the call named a ref in `crop`** and that request was
   declined — at step 2, or by `cap.declined` coming back from a
   `{ kind: 'detail' }` capture (those values are `region-too-small`,
   `region-is-frame`, `processing-failed`, already members of
   `CropDeclineReason`):
   `` `\nfiled the full frame (crop declined: ${DECLINE_PROSE[reason]})` ``.
   Auto-trim declines stay silent (§3): the missing parenthetical is the
   record.

**Why the modal check reads `stateFor(id).last` instead of taking a fresh
walk:** running `observe()` inside capture would advance the agent's diff
baseline and discard the returned ops, leaving the model's beliefs one state
behind with no diff ever delivered — the phantom-belief class the engine
exists to prevent. (The vault fill path does call `observe()` mid-pipeline,
but there the observation *is* the planning input; here it would be a side
effect.) Capture therefore consults the model the agent already holds, and
the freshness gap is §3's first disclosed residual.

### 7.5 `src/main/ipc.ts` — the human path

`capture:page` swaps `capturePage` for
`captureForFiling(t.webContents(id), { kind: 'trim' })` and adds
`cropNote: cap.note` to its `routeCapture` options — the same literal
spelling. The three scrubbed arguments, the surrounding comments, and the
no-agent-refusal carve-out stay exactly as they are. No renderer change; the
existing `CaptureResult` shape is untouched.

## 8. Verification — level chosen, and why

**Level: unit coverage of the pure core, one acceptance case at the seam, one
guard leg. Not a RED-first sabotage battery.** Proportionality: this is a UI
feature. No page byte gains a new route into agent context or off the machine
(§5, §6); the one new caption channel is closed-alphabet by construction and
by test; the residual risk is *filing a misleading record*, which the decline
rules and the always-annotated captions address. The full battery is for
mechanism classes guarding credentials; spending it here would be the
inverse of the proportionality the security programme's own closure argued.

All in one new file, `test/autocrop.test.ts` (vitest, no Electron runtime —
the core is plain data):

1. `contentBounds`: white frame, dark block at a known rect → exact tight
   bounds. Same with a dark background (colour-agnostic). Content flush to one
   edge → that edge's bound is 0/edge (no over-trim).
2. `contentBounds` declines: four disagreeing corners → `null`; fully blank →
   `null`.
3. `trimRect` acceptance case (the seam's math end-to-end): 320×200 white
   `Bitmap`, content block 80×40 at (60, 50) → exact rect
   `[44, 34, 112, 72]` (tight bounds + 16px pad), min-dim satisfied, savings
   ≈ 87% → accepted. Then a 100×60 content block at (8, 8) on a 120×80
   frame → the padded rect clamps to the full frame, savings 0 → declined
   `savings-too-small`; a 10×10 content block → result expanded to ≥ 64×64,
   centred, clamped.
4. `detectScale`: exact at 1.0; a byte length implying 1.25 that fails the
   round-trip equation → `null`; length not divisible by 4 → `null`.
5. `detailRect`: pad + clamp exactness; sub-`MIN_DETAIL_DIM` target →
   `region-too-small`; near-frame target → `region-is-frame`; outward
   rounding (floor origin, ceil extent) asserted on a fractional input.
6. `cropNoteFor` closed alphabet, as a property: for a sweep of valid inputs
   the output matches `/^(trimmed|detail e\d+) \d+×\d+ of \d+×\d+$/`; throws
   on `kind: 'detail'` with ref `'x'`, `'e1"'`, `''`, `'e1 e2'`; throws on
   non-integer or non-positive dimensions.
7. **The one guard leg** (source-reading, the `urlsurfaces.test.ts` /
   `docs.test.ts` precedent — assert over the text when the property lives in
   the text): scanning `src/**/*.ts` with prose-stripped lines,
   (a) every occurrence of `cropNote:` outside `src/capture/capture.ts`'s
   `RouteOptions` declaration is exactly `cropNote: cap.note`, and it occurs
   at exactly the two known `routeCapture` call sites
   (`src/main/ipc.ts`, `src/mcp/tools.ts`); (b) `cropNoteFor(` is called in
   `src/capture/autocrop.ts` and `src/capture/capture.ts` and nowhere else.
   Together with case 6 this pins the whole caption channel: one producer,
   closed alphabet, no third spelling a reviewer has to notice.

Suites that must pass **unmodified**: `test/urlsurfaces.test.ts` (the three
page-influenced arguments, both call sites), `test/egress.test.ts` (the
`capturePage` row stays keyed and true, and autocrop adds no surface),
`npx tsc --noEmit`, and the rest of `npx vitest run`.

**Live smoke, once, before calling it done** (this repo's method: nothing is
believed until the real output disagrees or fails to): launch Aperture, open a
mostly-blank fixture (any `test/fixtures` page qualifies), press the toolbar
capture button with Notion unconfigured, and confirm the PNG on disk has
dimensions smaller than the viewport; then via MCP call `browser_capture`
with `crop` set to a snapshotted ref on an agent-opened tab and confirm the
reply carries the `(W×H of FW×FH)` parenthetical, and once with a bogus ref
and confirm `filed the full frame (crop declined: unknown ref …)`. Delete the
throwaway PNGs.

**Already probed during specification** (throwaway Electron script against
this repo's own Electron, Windows 11, display scale 1.0): `capturePage()`
returns a NativeImage whose `getSize()` equals the CSS viewport;
`toBitmap()` is 4 bytes/px at `getSize()` dimensions, BGRA (a pure-red pixel
reads `[0, 0, 255, 255]`); `crop()` takes CSS/DIP coordinates and a 16×16
crop of a known square returned exactly those pixels; `toPNG()` of the crop
decodes at 16×16. The §7 design leans on nothing beyond these observations
plus the runtime invariants.

## 9. What was not verified

- **HiDPI (`devicePixelRatio > 1`) semantics of `toBitmap()` and `crop()`.**
  The probe machine runs scale 1.0. Unknown: whether `toBitmap()` returns the
  scaled representation, and whether `crop()`'s rect is interpreted in DIP on
  a scaled image. The design does not depend on the answer: `detectScale`'s
  round-trip equation and the post-crop size invariant (§7.2 step 5) turn
  every wrong assumption into a full-frame filing. On a 125%-scale display the
  worst case is that auto-trim always declines — degraded, disclosed, safe.
- **The Notion caption rendering of the note.** The Notion API path is itself
  unverified in this repo (`docs/HANDOFF.md`, product surfaces item); the note
  rides the existing `caption` string through the existing `appendCapture`
  call, so it inherits whatever that path does. The disk fallback carries no
  caption — a disk-filed crop is annotated only in the agent reply; accepted
  (the filename pattern is unchanged and dated, and adding a dims suffix to
  filenames was considered and dropped as churn on a path other tooling may
  glob).
- **Subframe rect behaviour of the existing `resolveRef`.** Assumed
  subframe-relative (each frame's preload measures its own viewport), which is
  why detail crop refuses `frameId !== 0` rather than attempting composition.
  If the assumption is wrong in the safe direction it costs nothing; nobody
  should widen the rule without measuring.
- Whether any out-of-repo consumer imports `capturePage`. In-repo callers are
  exactly the two call sites (grepped at `abca603`); the export is renamed
  precisely so a forgotten third caller becomes a compile error instead of a
  silent behaviour change.

## 10. Deliberately not included

- **No human-side crop UI** — no region picker, no settings toggle, no
  per-capture prompt. The toolbar stays one button.
- **No diff-region crop mode** (§1b's reasons are structural, not effort-bound)
  and **no acted-element inference**.
- **No image analysis beyond uniform-margin detection** — no OCR, no saliency,
  no "detect the dialog" heuristics. Every rejected variant here trades
  auditability for cleverness on a path that produces records.
- **No change to what the agent can see** — the image still never enters agent
  context, and no thumbnail/summary substitute is added.
- **No new page-influenced argument to `routeCapture`**, and no edit to
  `test/urlsurfaces.test.ts` or `security.md`. If a future iteration ever
  routes a page-derived string into the caption channel, it inherits the
  needle-scrub rule those enforce — that iteration must add its scrub and its
  guard leg, not weaken this one's closed alphabet.
- **No bench work** — no fidelity scenario, no guard-phase leg, no watched-set
  file is touched by the test plan; the cohort-integrity rules in
  `docs/HANDOFF.md` are unaffected (and the h2h stores are closed and owed
  nothing regardless).
- **No capture of anything but the visible viewport** — no full-page scroll
  stitching, no element-capture CDP surface, no off-viewport composition.
- **Dark-mode contrast work and voice input** (backlog items 2 and 3) are
  untouched; auto-trim's colour-agnostic background rule is the only point of
  contact with theming, and it needs no coordination.
