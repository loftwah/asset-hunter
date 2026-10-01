# UNSLOP — what not to build

`DESIGN.md` says what the product should look like. This file says what it must
not look like, which is the more useful half when several agents are working
without a designer in the room.

Each rule is stated as a pattern to reject, the reason it is wrong *for this
product*, and what to do instead. A pattern is allowed when a concrete product
reason is named in the code — the test is whether you can state that reason
without gesturing at "modern" or "clean".

---

## Rejected by default

### Generic AI purple/blue gradients

**Reject.** A gradient is a claim that the design is doing something. The
catalogue's job is to make specimens legible; an indigo-to-violet wash behind a
plate competes with the plate's own colour, which is content.

**Instead:** one accent, `--ember`, reserved for action, selection and the single
highest-priority element on a viewport. If a region needs hierarchy, change its
tier's fill opacity, not its hue.

### Card soup

**Reject.** A grid of identical rounded boxes with a shadow, an icon and a title
is a component-library demo, not a catalogue. It implies every entry deserves
equal weight, which is the opposite of the product's thesis.

**Instead:** the density ramp in `DESIGN.md` §5. One hero region, one secondary
band, a quieter body, then borderless reference rows. The eye should land
somewhere specific.

### Excessive rounded containers

**Reject.** Pills and rounded rectangles on everything flatten hierarchy — when
everything is a pill, nothing is emphasised. Large radii also fight the plates,
whose corners are square by convention.

**Instead:** `--radius: 3px` for surfaces, `--radius-lg: 5px` where a control
needs it. Pills only for filters and counts, which are genuinely chip-shaped
things.

### Meaningless badges and metrics

**Reject.** A row of numbers with no denominator. `4.2★`, `12 uses`, `98% match`
— none of these mean anything without provenance, and inventing them is worse
than omitting them.

**Instead:** show what is actually known. Until the hunt engine supplies verified
sources, the tally reads `0`, and `0` is a legitimate, informative answer. The
`Unverified` state is documented rather than hidden.

### Fake terminal styling

**Reject.** Monospace-everything with a blinking cursor and green-on-black
signals "developer tool" and nothing else. This is a media catalogue for
creative and technical people, not a CLI.

**Instead:** mono is the *label* voice only — field names, provenance, counts,
`caps` micro-type at 10–13px with wide tracking. Body copy is a proportional
face. A whole interface set in mono reads as a costume.

### Decorative glassmorphism

**Reject.** Backdrop blur over media costs contrast, and on a dark catalogue it
blurs the specimens, which are the content.

**Instead:** the sticky masthead uses an 88%-opaque canvas with a 14px blur —
enough to separate it from the wall, opaque enough that plate colour under it
stays accurate. No blur inside a plate, ever.

### Huge hero copy pushing the catalogue below the fold

**Reject.** The current hero occupies about 400px on desktop and roughly a
third of a phone screen. A tagline several screens tall means the visitor never
reaches the wall, which is the entire product.

**Instead:** one headline (max 22ch), one paragraph of lede, one tally row, then
plates. If a copy change pushes the first row of plates past the fold, the copy
is wrong.

### Animation for its own sake

**Reject:** entrance animations, parallax, scroll-jacked reveals, animated
gradients, counters that tick up.

**Allow:** transitions that explain a state change — tile hover lifting 2px,
media scaling 1.028 over 420ms, focus rings appearing. Under
`prefers-reduced-motion` all of it collapses.

### Arbitrary iconography

**Reject** when the media itself communicates the idea. A magnifier next to
"Search" adds nothing; a glyph for "no licence found" does work because it is
paired with a word, not instead of one.

**Instead:** the wordmark's aperture mark is the only persistent icon. Provenance
uses a dot or ring — 8px shapes that pair with a label.

### Duplicated metadata on every tile

**Reject.** Repeating the vertical and rights status 24 times on one screen makes
both unreadable and forces a scan that the filter rail already provides.

**Instead:** the tile carries the plate, the title, and the two provenance marks.
Vertical is present because it orients the entry; anything the rail or the legend
already says is not repeated per tile.

---

## Also rejected

| Pattern                    | Why                                                        |
| -------------------------- | ---------------------------------------------------------- |
| Skeleton spinners          | Content is server-rendered and fast; a flash of skeleton reads as a failure |
| "Nothing found" with no way forward | Every empty state offers search, a filter, or a vertical  |
| Modal detail view          | A detail page is linkable, shareable and keyboard-navigable  |
| Infinite scroll            | The catalogue is finite; say so, and make it countable      |
| Tooltips as the only label | Touch has no hover; a tooltip-only fact is invisible on mobile |
| A second CMS               | EmDash owns content, media, auth and admin. Duplicating them forks the product |
| Colour-only status         | Fails greyscale and colour-blindness; every status has a word |
| Invented statistics        | A plausible-looking number is fabricated evidence. Unverified reads zero or absent |

---

## Adding a pattern

If a pattern genuinely helps, add it here with the reason, and put the reason in
a comment at the use site. A rule with an exception attached is a decision; a
rule with a vague exception is a leak.

---

## Review checklist

Before calling UI work done:

- [ ] Does the first row of plates sit above the fold at 390px?
- [ ] Does any region use a hue other than `--ember` for emphasis?
- [ ] Are there exactly zero floating elements — badge stacks, star ratings, view counters?
- [ ] Is every status expressed as a word as well as a colour?
- [ ] Does every interactive element clear 44px on touch?
- [ ] Does the page survive `prefers-reduced-motion` with nothing lost?
- [ ] Is every claim on screen traceable to something actually measured?
- [ ] Could someone screenshot this at 400px wide and still tell what the product is?
