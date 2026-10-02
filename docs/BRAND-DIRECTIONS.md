# Brand comparisons: how this project runs one

`docs/BRAND.md` records that the aperture mark was refined in place without a
recorded comparison of different brand directions, and that #16's criterion
*"several genuinely different brand directions are compared before selection"*
is therefore **unmet**. Reconstructing that comparison after the fact would be
fiction, so it has not been done.

This file is the replacement: a protocol, so the next identity change is
documented rather than another undocumented one. It is a procedure to follow, not
a record to believe. Nothing here has been run as a full direction exploration.

## The one comparison that was real

While fixing #16, the icon form was chosen by comparison. Six candidates were
rendered on the 24-unit grid at 16, 20, 32 and 48px, magnified ×6 with
`image-rendering: pixelated`, and decided on the pixels rather than on how the
parameters looked in the source.

| | Candidate | Outcome |
| --- | --- | --- |
| A | ring r9.25 / 2.5 + lozenge 4×6.4 | **Chosen.** Clean annulus, distinct lozenge at 16px, keeps the mark's skeleton |
| B | ring r9.25 / 2.5 + lozenge 4.5×7.2 | Lozenge swells; ring looks thin against it at 48px |
| C | ring r9 / 2.25 + lozenge 4×6.4 | Ring goes grey at 16px — 1.5px is below what reads as a stroke |
| D | ring r9.25 / 3 + lozenge 5×8 | Reads as a washer. The original attempt; rejected on sight |
| E | two rings r9.5 / 2.5 + r4 / 2 | Reads as a bullseye — exactly what the `full` form avoids — and loses the lozenge |
| F | A plus one tick | The single tick reads as a stray blob; arbitrary asymmetry |

What made this a real comparison rather than a preference: the decision rule was
fixed in advance (it must read at 16px, and it must still be recognisably *this*
mark), it was measured at the sizes the product actually uses, and the losers are
recorded with the reason they lost.

## Protocol for a full direction comparison

Use this the next time the identity is genuinely up for change. It is
deliberately more work than picking one and living with it, because that is the
cost of the criterion.

### 1. Fix the decision rule before drawing anything

Write down, in advance, what makes a direction win. For this product that is
already constrained by `DESIGN.md` and `docs/UNSLOP.md`:

- it must survive at 16px and must not read as a bullseye;
- it must coexist with colourful, monochrome, animated and transparent example
  media without tinting or cropping any of it;
- it must be monochrome-able — the identity cannot depend on the accent, because
  `--ember` is reserved for action;
- no gradients, no AI-purple, no corporate blue/grey (`docs/UNSLOP.md`);
- type must stay readable at 10–13px mono.

A rule written after the winner is picked is a rationalisation, not a rule.

### 2. Produce materially different directions

Different in **concept**, not colour. Recolouring one mark five ways is one
direction, and treating it as five is the failure mode this protocol exists to
prevent. For this product, "materially different" means a different answer to
"what is this thing":

- an aperture/sight (what exists now);
- a specimen frame or plate corner;
- a compression mark — many things reduced to one representative shape;
- an instrument-panel element — a scale, a reticle, a graticule;
- a specimen label or tag.

Five of those is a reasonable minimum. Two or three is not a comparison.

### 3. Apply each to the same real compositions

Never an isolated logo mockup. Each direction gets:

- the real masthead at 1280px and at 360px (`npm run check:visual -- --url …`
  captures both);
- the real wall, full-bleed, at 1280px;
- one real drill-in, so the mark is judged next to the type and the rights panel;
- the favicon at 16, 20, 32 and 48px, magnified ×6.

Real product capture only. A mockup tells you how the mark looks in a vacuum,
which is the one thing that does not matter.

### 4. Reproduce the sheet

`scripts/visual-qa.mjs` already captures the routes and viewport matrix, and
`scripts/build-brand.mjs` already rasterises an SVG at a given size through the
same Chromium the reader gets. A direction comparison is a small script that
composes those into one sheet per direction, so a reader can see all five at the
three sizes side by side and the sheet can be regenerated rather than
re-screenshotted by hand.

### 5. Record the decision *and* the rejections

The deliverable is not the winner. It is the winner plus, for each loser, the
specific reason it lost at a specific size. A comparison with no losers recorded
did not happen.

### 6. Then, and only then, change the identity

Edit `src/lib/brand/mark.ts`, run `npm run brand:build`, and let `brand:check`
and `tests/brand.test.ts` decide whether the change is honest. Update
`DESIGN.md` §9.4a and `docs/BRAND.md` in the same commit — `tests/brand.test.ts`
fails if the documented numbers stop matching the geometry.

## When to run this

Not for a tweak. This is for a change of concept: a different mark, a different
name, a different relationship to the catalogue. Refining one direction — as
#16 did with the icon form above — needs the smaller comparison, and needs its
rejections recorded, but does not need five concepts.
