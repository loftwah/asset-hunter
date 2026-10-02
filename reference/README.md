# Reference compositions

Real captures of the running product, committed so the visual direction has
something concrete to be compared against. Not marketing renders — these are
the actual routes at the actual breakpoints.

Regenerate:

```bash
npm run dev
node scripts/capture-reference.mjs
```

| File                        | What it shows                                                   |
| --------------------------- | --------------------------------------------------------------- |
| `wall--1280.png`            | The wall at desktop: band, filter rail, lead tile, grid          |
| `wall-mobile--390.png`      | The wall on a phone — the check for the fold and the tap targets |
| `detail--1280.png`          | Drill-in: plate beside technique, notes, scaffold and rights     |
| `verticals--1280.png`       | Coverage map, including the deliberately unmapped list           |
| `collections--1280.png`     | Overlapping curated groupings                                    |
| `search--1280.png`          | Results with vertical facets and honest counts                   |
| `licensing--1280.png`       | Rights statuses in full                                          |
| `404--1280.png`             | Search and verticals rather than a dead end                      |

## The public gallery

Five of these captures are also **served**, as the content of `/gallery`.
`scripts/capture-reference.mjs` writes them into `public/gallery/` from the
same pass — the same bytes, not a second screenshot — and `src/lib/gallery.ts`
names each one with its alt text and the live route it depicts.

That is why the gallery is not a separate capture script and not a mock: there
is no compositing step between the product and the image, so the page cannot
show something prettier than the real thing.

## What to check them against

`DESIGN.md` is the authority and `docs/UNSLOP.md` is the rejection list. Use
these captures to answer:

- Is the first row of plates above the fold? (`DESIGN.md` §5b has the measured
  numbers; `npm run check:visual` fails if it regresses)
- Does the lead tile span two columns of the same grid rather than sitting in a
  band of its own, and is its plate still 4:5?
- Is there exactly one region competing for attention?
- Does any colour appear that is not `--ember`, ink, surface or line?
- Does the rights language read as permissive anywhere it should not?
- Does anything look like a component-library demo?

If a capture contradicts `DESIGN.md`, one of them is wrong and the design
document is the thing to change deliberately — not the capture.

## Why these are checked in

`screenshots/` is gitignored because it is regenerated on every visual QA run and
diffing 50 viewport captures adds noise. This directory is a small, stable set
that exists to be looked at when making a design change.
