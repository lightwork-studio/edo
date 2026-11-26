# Edo design export

Approved UI designs for **Edo**, a calorie tracker for iPhone and Android. It is built with Expo, works with or without sync, and offers server-side AI for speech and photo logging plus an MCP server for AI agents. These files are a design reference. They are not app code.

## What's here

| Path | What it is |
| --- | --- |
| `screens/*.html` | Each approved screen as a standalone HTML page (390×844, inline CSS, Inter from Google Fonts). Open one in a browser, or read it as the exact spec for spacing, sizes and colours. |
| `screens/*.png` | The same screens rendered at 2× (780×1688). |
| `alternatives/` | Variants that were considered and **not chosen**. Keep them for context only. |
| `index.html` | A gallery of all screens, grouped by area. |
| `manifest.json` | Every screen with its file, canvas page and title. |

## Style

Dark only. The look is dark graphite with one saffron accent, a plain sans-serif, and semibold or bold numbers. Progress is always shown with rings, never with bars at the top of a screen. Navigation is a bottom tab bar with a raised microphone in the middle.

**Colours**

| Token | Value | Use |
| --- | --- | --- |
| background | `#141517` | Screen ground |
| surface | `#1F2023` | Cards, sheets |
| surface-2 | `#232427` / `#292A2E` / `#2C2D31` | Chips, inputs, ring tracks, pills |
| border | `#3A3B40` | Outlined chips and buttons |
| text | `#F4F2EE` | Primary text |
| text-muted | `#B0ACA5` | Secondary text and units |
| text-faint | `#8A8780` | Tertiary text, barcode digits |
| accent (saffron) | `#F6B84D` | Primary actions, calorie ring, active tab, "≈" estimates |
| on-accent | `#2B1B00` | Text and icons on saffron |
| accent-soft | accent at 16 % (`#F6B84D29`) | Accent backgrounds (estimate pills, selected chips) |
| accent-dim | accent at 35 % (`#F6B84D59`) | The "already eaten" part of the calorie ring |
| protein | `#5FD38D` | |
| carbs | `#E8DD72` | |
| fat | `#FF7D8A` | Macro "already eaten" arcs use these colours at 35 % alpha (`…59`) |
| transcript links | `#6CB4FF`, `#B99CFF`, `#4FD3D9`, `#FF9C7A` | The colour tying a spoken phrase to its item (tint = colour + `3D` alpha) |

The accent was also tested as light blue (`#7CC4FA`) and mint (`#52E0B8`). Saffron is the default.

**Type:** Inter at 400, 500, 600 and 700.
- Screen title or date line: 17/700.
- Big numbers: 26–29/700 (inside the calorie ring: 29).
- Item names: 15–16/500–600.
- kcal values: 15–17/600–700.
- Secondary text: 13. Labels: 11–12.

**Shape:**
- Cards have 20–24 px radius, item cards 18, sheets 28–30 at the top.
- Pills are 30 px tall with a fully rounded radius.
- The primary button is 56 px tall with an 18 px radius.
- Touch targets are at least 44 px.
- The tab bar is 84 px, and the raised mic button is 64 px across.

## Screens

### Today (`t1-Today`)
- **Header:** a single slim 52 px row with "Wed, 25 Nov ⌄" (opens a day picker), plus small camera and barcode buttons. There is no big "Today" title.
- **Week strip:** one 34 px ring per day, with the date inside and kcal below. An over-target day shows a full ring and "+90". Today is in saffron.
- **Hero card:**
  - A 150 px calorie ring with "1,086 kcal left" inside.
  - Stacked macro rings beside it ("77 g left · Protein · 73 / 150").
  - A footer line: "1,064 eaten · 2,150 target · 49 %".
- **Meal cards:** a time and kcal for each meal, then one row per item.
- **Suggestion chips** above the tab bar (repeat a meal, usual foods), and the hint "Hold to speak · tap to type".
- **Tab bar:** Today · Foods · [raised mic "Log"] · Progress · Profile.
- **While scrolling:** a slim pinned strip under the date shows a mini kcal ring and P/C/F rings (see `s5-Logged`).

### Logging (`s*`, `p*`, `b*`)
**Rules for all logging**
- The meal is chosen from the time of day and can be changed.
- Speech, typing and photo always end on a review screen. Nothing is logged without it.
- One recording fills one meal with several items.
- The app comes in German and English.

**Speech**
- `s1-Listening`: the live transcript only. The phone does the speech-to-text. No items are parsed while you speak.
- `s6-Type`: the same flow, typed.
- `s1c-Reading`: shown after you stop. The server AI turns the transcript into items. While it works, the screen shows "Matching your words to foods…" with placeholder cards.
- `s2-Review` / `s2c-Review-Rings`: the review screen.
  - Each recognised phrase in the transcript gets a **tinted background** in its own colour, and the matching item uses the same colour.
  - Every item has a source label (your food, recent, BLS) and an amount pill.
  - An amount Edo guessed shows as a saffron "≈" pill.
  - "Your day with this" shows the day rings: the faded arc is what you've already eaten, the bright arc is this meal, with "+23" inside and "96 / 150 g" below.
- `s3-Amount`: check a guessed amount (slices, grams or portion, plus "Remember 30 g per slice").
- `s4-Swap`: swap the matched food.
- `s5-Logged`: back on Today with an Undo snackbar.
- `s8-Review-DE`: the German UI, as a check that the longer text fits.

**Search**
- `s7-Search`: classic search with All · Recent · My foods · Recipes, a quick "+" per result, "Create food" and "Quick kcal" (log a bare calorie number).
- `s7c-Food-Rings`: the food detail screen. Its "impact" on the day is shown as **rings** for kcal, P, C and F.
- `s7d-Food-Over`: going over a target. The bright arc keeps going as a second lap, with a "42 g over" badge.

**Photo**
- `p1-Camera`: the camera, with an optional note ("with parmesan").
- `p2-Reading`: the reading screen, with the photo in place of the transcript.
- `p3-Review`: the photo review. There are **no markers on the photo**, because models can't reliably locate each food, so there's no colour link here and the items have neutral tiles. Every amount is a "≈" estimate.

**Barcode**
- `b1-Scanner`: the scanner.
- `b2-Found`: a result sheet over the scanner with amount, day rings, "Add" and "Scan another after adding".
- `b4-Multiple`: when one code matches **several products**, a picker opens ("Pick the one that matches your pack", "Remember my pick").
- `b3-NotFound`: "Enter values yourself" or "Search by name". Photographing the nutrition label is out for now. Products added with a barcode are **always shared with Open Food Facts**, with no opt-out.

### Foods (`f*`)
- `f1-Foods`: My foods · Recipes · Meals · Favourites. Each food shows its source, usual portion, how often it's been used, and kcal. Favourites have a star.
- `f1b-Recipes`: recipe cards showing servings, kcal and P/C/F per serving, with "Log 1 serving". Recipes can't be imported from links.
- `f2-Recipe`: the recipe editor.
  - Servings plus an optional **cooked weight**, so you can log by grams on the plate.
  - Ingredients use the same amount pills as the review screen, with drag to reorder and swipe to delete.
  - "Add ingredient" works by speech or barcode too.
- `f3-CreateFood`: create a food with values per 100 g or per portion. A check line shows the kcal calculated from the macros. If the food has a barcode, a note says it's shared with Open Food Facts.

### Progress + Profile (`g*`, `h*`)
- `g1-Progress`: three cards.
  - Weight: the trend is a simple 7-day **moving average of weigh-ins**, drawn as a line with daily dots.
  - Calories: the last 7 days as week rings.
  - Macros: averages as rings, plus how often you hit your protein target.
- `g2-Weight`: a sheet for entering your weight, plus Apple Health import.
- `h1-Profile`:
  - Targets.
  - Data: sync, Health, FDDB import, export.
  - AI & agents: MCP access, AI features.
  - App: language, units, meal times.
- `h2-Targets`: **Calculated** (Mifflin-St Jeor, from your body data and goal) or **Manual**.
  - Protein and fat are set by you, and carbs fill the rest.
  - "Adaptive" is marked "Coming later".
- `h3-Agents`: the MCP server URL, access tokens with scopes and Revoke, and what agents may do. Their edits are patches checked against what they saw.

## Product decisions behind the designs

- **Modes**, as in Leve:
  - Local only: no account, and the AI features are hidden.
  - Managed sync: Edo's server, with AI included.
  - Self-hosted: your own server URL and your own AI key.
- **Sync** follows Leve's model: records with server revisions, and stale edits are rejected. The client does a three-way merge, field by field and nested items by id, and only asks you when the same field changed to different values. MCP edit tools take patches with the values the agent saw, never whole records.
- **Food data:** Open Food Facts, BLS and USDA as a fallback. FDDB import is a one-off CSV import.

## Not designed yet

- The Meals list (saved meal combinations).
- "Create food" without a barcode.
- The FDDB import flow.
- First-run setup (choosing a mode, signing in to sync).
