# Product vocabulary

The terminology authority for #60. One concept, one word, everywhere: the wall,
search, the admin, the engine, the docs and the API.

The rule that makes this file worth having: **a term is chosen once, here, and
everywhere else looks it up.** `src/lib/vocabulary.ts` is the implementation of
this page; a component that re-derives a label from a slug is how "UI / Web"
becomes "Ui Web" on one surface and "ui-web" on another. That already happened
once and this file exists so it cannot happen twice.

## The terms

| Concept            | Say this            | Never say                                                  | Why                                                                 |
| ------------------ | ------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| Distinct idea/technique/pattern/mechanic | **possibility** | idea (alone), treatment (alone), concept, asset type | "Idea" is too weak to be a unit of the catalogue. "Treatment" is used, but only as part of a sentence about how something was made. |
| Evidence for one | **example**        | item, result, hit, result tile                          | "Result" collides with a search result. |
| Upstream / derived / generated | **origin**, with the three values **upstream**, **derived**, **generated** | provenance (alone), source type | "Provenance" is the whole evidence trail — repo, ref, path, commit, hash — and origin is one field inside it. |
| A reusable asset | **cleared** material | licensed (alone), free, legal, approved              | "Licensed" says a licence exists, not that it permits the use being made. |
| Permission with an obligation | **attribution** | credited, with credit                                | "With credit" understates a licence obligation. |
| Found but not understood | **review** | unclear, risky, needs a lawyer, unverified licence    | "Unverified licence" is a claim about evidence; `review` is a status with a defined meaning. |
| No permission established | **reference only** | unlicensed, illegal, stolen, no-licence, forbidden    | "Unlicensed" reads as an accusation about the author. "Forbidden" overstates it — most of it is just unstated. |
| Grouping by area | **vertical** | category, genre, tag, topic                           | A vertical answers "what area is this". |
| Overlapping grouping by purpose | **collection** | playlist, board (except the reader's own), set        | Collections overlap by design; a partition would collapse the second axis into the first. |
| A reader's saved list | **board** / **shortlist** | collection (used for an editor-made one)          | The reader's board is theirs and local; an editorial collection belongs to the catalogue. |
| Grouping candidates into possibilities | **grouping** | deduplication, merging, dedupe                      | It is a judgement about a technique, not a string match. `group` is honest about its own uncertainty. |
| Licence text that was read | **licence evidence** | licence metadata, licence check                   | Metadata is a hint. Evidence is the bytes, the hash and the quote. |
| A statement about the source | **provenance** | source, origin, where it came from                  | "Source" is the URL. Provenance includes the commit and the hash. |
| Machine observation | **verified sources** (count), **novelty**, **coverage** | stats, metrics, score, quality                     | Each names what was measured. A generic "score" invites reading it as quality. |
| A person's judgement | **editorial rank**, **featured** | rating, score, popularity                      | Deliberately named differently from community rating so the two never blur. |
| A reader's judgement | **community rating** | score, stars, quality                              | Named for what it is: one reader's opinion. |

## The distinction the whole product rests on

> **Possibility is not permission.**

Knowing a treatment exists says nothing about whether you may copy the asset
that demonstrated it. So rights attach to an **example**, never to a
possibility, and a possibility's status is the **weakest** status across its
examples — not the best one.

A fresh reader must be able to tell these two apart without effort:

- "this is an example of an idea" → a **possibility**, with **examples** beneath it.
- "this asset is cleared for reuse" → an **example** whose rights status is
  **cleared**, and only that one.

The UI keeps them apart on purpose: the wall shows the possibility, the drill-in
shows the rights, and the rights are stated in a sentence rather than a colour.
A green dot on a tile says `Cleared` in words next to it, and the detail page
says what "cleared" means for *this* example.

## Information architecture

The catalogue is primary. There is no marketing funnel in front of it — the
homepage is the wall, and the wall is the product.

| You want to                     | Go to                                       | Why it is the shortest path                              |
| ------------------------------- | ------------------------------------------- | -------------------------------------------------------- |
| browse everything               | `/`                                         | The wall. No landing page in front of it.                |
| browse one area                 | `/?vertical=<slug>`, or `/verticals` for the map | The URL is the filter, so it is shareable and works without JS |
| search a term you know          | `/search?q=`                               | A ranked **list**, not a grid — see below                 |
| describe a problem instead      | `/search`, which says to search for the problem | Same surface; the vocabulary is the obstacle             |
| keep candidates                 | `+` on any tile, then `/board`              | Works without JavaScript                                  |
| see what a possibility is       | `/possibilities/<slug>`                    | A page, never a modal: linkable, shareable, in history   |
| understand the rights           | the drill-in, or `/pages/licensing`         | Rights are never behind a hover                           |
| see the state of the catalogue  | `/verticals`                               | Coverage map, deliberately labelled partial               |
| change the catalogue            | `/_emdash/admin`                           | EmDash's own interface, deliberately not themed like the public site |

**Search results are rows, not tiles.** A search for a known term is a
comparison task, and a grid of four plates makes four results look like the whole
answer. Each row carries a thumbnail, the title, its tagline, its vertical and
media, its rights markers, and a line of the entry's own summary with the query
terms marked — because *why this matched* is the question a results list has to
answer.

**A drill-in is a page.** No modal: an overlay would save a navigation and cost
linkability, history, keyboard reachability and indexing.

## Copy voice

- **Short and concrete.** "24 possibilities", not "a rich collection of
  possibilities spanning multiple domains".
- **No AI hype.** No "unleash", "elevate", "supercharge", "seamless", "dive in".
- **No false certainty in model judgements.** If something was not measured, say
  it was not measured. `0 verified sources` is an answer; a plausible-looking
  count is not.
- **Rights wording stays precise.** The four statuses have fixed meanings and
  they are defined in `/pages/licensing` in full sentences. Never shorten
  "reference only" to "ref" or "R".
- **Warnings explain the actual issue and the action.** "Preview failed to load.
  The entry and its rights are unaffected" — not "Something went wrong".
- **Buttons describe the action.** "Open the catalogue", "Clear this board",
  "Show every vertical". Never "Submit", "Go", "Click here".
- **Numbers have a denominator or they do not appear.** `3 possibilities · 1
  collection` is fine. `98% match` is not, because nothing measured it.

## Empty, error and onboarding copy

Every one of these is a state a reader can reach, and each one has to say what is
missing and what to do next.

| State                  | What it says                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------- |
| First visit            | The wall with one sentence of framing. No tutorial, no modal, no "welcome".                    |
| Nothing catalogued     | "Nothing catalogued yet" — and which vertical to try, because an empty catalogue is usually one filter. |
| Empty collection       | "This collection is empty" — and the wall, because the collection existing but being empty is different from it not existing. |
| Zero-result search     | "No match for …", then *search for the problem rather than the solution*, plus verticals. The absence of a result is more likely a gap than an error, and the copy says so. |
| Empty board            | "This board is empty", plus the wall and the verticals.                                         |
| Unsupported reference  | "Preview failed to load. The entry and its rights are unaffected."                             |
| No reusable asset, but a useful reference exists | The entry stands at **reference only**, with the extent of that permission stated: that *is* the permission. |
| Rights uncertainty     | **review**, with "read before use" and what was found that was not understood well enough to rely on. |
| Dead upstream source   | "The upstream source is no longer reachable. The evidence recorded here is what was read at the time." — never a silent blank plate. |
| No plate yet           | The hatched `NO PLATE` placeholder, which says on its face that nothing has been generated.      |
| 404                    | A search field and the verticals. Not a dead end and not a joke.                                 |

## Where each term is defined

| Place                                       | Role                                              |
| ------------------------------------------- | ------------------------------------------------- |
| `src/lib/vocabulary.ts`                     | The implementation. Components look terms up here. |
| `seed/atlas.json`                           | The content that uses them.                        |
| `/pages/licensing`                          | The four statuses in full sentences, for readers. |
| `DESIGN.md`                                 | How the terms are presented.                       |
| `engine/src/licence.ts`                     | The engine's classification, mapped to the statuses. |
| `docs/ARCHITECTURE.md`                      | The field-ownership table, by term.                |

If a term here is wrong, change it here first, then follow it. Renaming the same
concept on one surface is how a catalogue stops being a catalogue and starts
being a database with a theme.