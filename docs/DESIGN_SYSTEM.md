# Design system — "Plate & Graphite"

Sky Time Machine is a scientific instrument, not a dashboard. This system is shared by the web app
(`frontend/src/app/globals.css`) and the project deck (`presentation/scripts/build_deck.js`).

## Audit: what made the previous design look generic

| Pattern | Where | Replaced by |
|---|---|---|
| Blue as the only accent (links, primary buttons, focus, footprints, D1) | tokens, buttons, map | graphite ink for actions, amber for the single highlight, blue only as the shortest-wavelength detector |
| Floating translucent panels with `backdrop-blur` over the sky map | Explore | a docked inspector column and a context bar; the map gets the full remaining area |
| A bordered, rounded card around every block (`Panel`) | every page | flat sections divided by hairline rules; one heading style |
| Uppercase tracked micro-labels on every box | every page | sentence-case section heads; uppercase only for data-kind tags |
| Filled bright primary buttons (`bg-accent`) | Explore, Timeline, Compare | one ink-filled primary per view; secondary actions are text buttons |
| Coloured tinted badge pills everywhere | candidates, checks | small square tags with a 1 px rule; status uses a glyph plus a word |
| Generic dark navy everywhere, including documents and tables | all pages | two surfaces: **paper** for reading and tables, **graphite** for image work |
| Deck: dark star-field background, cyan accents, rounded cards, icon circles | deck | paper slides, editorial serif titles, real figures as plates |

## Surfaces

Two themes, chosen by page purpose (`.theme-graphite` on the page root switches the whole document via `:has()`):

| Token | Paper (reading, tables, plots) | Graphite (sky map, image comparison) |
|---|---|---|
| `--bg` | `#F4F1EA` warm paper | `#161615` charcoal |
| `--panel` | `#FAF8F3` | `#1C1C1A` |
| `--panel-2` | `#ECE8DE` | `#252522` |
| `--line` / `--line-strong` | `#DCD6C8` / `#BFB7A6` | `#2E2D2A` / `#45433E` |
| `--text` / `--muted` / `--faint` | `#1C1B19` / `#5D594F` / `#8A8578` | `#ECE8DF` / `#A7A194` / `#78736A` |
| `--accent` (single highlight) | `#B4561E` burnt orange | `#E09A45` amber |
| `--original` (archive pixels) | `#5F6B2E` olive | `#A9B26C` |
| `--derived` (computed here) | `#A36A12` amber | `#D9A441` |
| `--pos` / `--neg` (brightening / fading) | `#B4501E` / `#3B5F86` | `#E07A3A` / `#7FA3CC` |
| `--good` / `--warn` / `--bad` | `#4F6B2A` / `#A36A12` / `#9E3A2B` | `#9DB46A` / `#D9A441` / `#D2665A` |

Images are always shown on a neutral dark plate (`--plate`, `#121211`), also on paper pages, like figures in
a journal.

## Detectors (ordinal, by wavelength)

D1–D6 are ordered from 0.75 to 5.0 µm, are always labelled, and use a wavelength-ordered palette (slate →
teal → olive → amber → rust → wine/violet). Checked with `presentation/scripts/check_palette.py --adjacent`
(OKLab ΔE×100: normal ≥ 15, protan/deutan/tritan ≥ 8):

- Paper `#3B5788 #27A595 #686D12 #D9A53E #C2552A #7A2A2B`: all checks pass.
- Graphite `#A3B6E3 #2A8E80 #9AA032 #F0C862 #D9653A #9C6BC0`: all checks pass.

## Typography

| Role | Web | Deck (Office-safe equivalent) |
|---|---|---|
| Titles, editorial headings | Source Serif 4, 600 | Georgia |
| Interface and body | IBM Plex Sans | Arial |
| Coordinates, times, measurements, IDs | IBM Plex Mono, tabular figures | Courier New |

Hierarchy comes from weight, spacing and alignment. Sizes: page title 26 px serif; section head 13 px sans
semibold; body 13–14 px; metadata 12 px mono; tags 10 px sans uppercase.

## Components

- **Section**: hairline rule on top, sentence-case head with optional right-aligned controls. No box, no fill.
- **Metadata strip**: label/value pairs in a row, labels in small sans, values in mono.
- **Toolbar**: one row of labelled controls separated by rules; segmented controls are flat with an ink
  underline for the active item.
- **Tags**: square, 1 px rule, uppercase 10 px. Used only for data kind (original / derived / synthetic),
  tier and verification.
- **Tables**: ruled rows, numeric columns right-aligned in mono, the selected row marked with `--panel-2`.
- **States**: loading is a thin progress rule plus a sentence saying what is being fetched; empty states say
  what to do next; errors say which service failed and keep the rest of the page usable.

Corners are square (2 px at most). No gradients, glows, blur, shadows, decorative stars or emoji icons.
