# Edo brand assets

The mark is a saffron ring with a bite taken out of its upper right: the calorie ring from the
Today screen, and something to eat. The wordmark is **edo** in Inter Bold with the ring as its "o".
Every file here is outlined, so nothing depends on a font being installed. Edo is dark only, so
the artwork is drawn for the graphite ground.

| File                     | Use                                                                     |
| ------------------------ | ----------------------------------------------------------------------- |
| `icon.svg`               | Rounded app tile for docs and the web.                                  |
| `mark.svg`               | The ring alone, trimmed to its bounds.                                  |
| `wordmark.svg`           | The full logo, trimmed to its bounds.                                   |
| `png/icon.png`           | App icon, 1024 px, opaque RGB with square corners (the OS rounds them). |
| `png/android-icon-*.png` | Android adaptive icon layers. The ring sits inside the safe zone.       |
| `png/favicon.png`        | Web favicon, 48 px.                                                     |
| `png/splash-icon.png`    | Transparent splash mark for a graphite splash colour.                   |

`generate.mjs` also writes the app icon and the adaptive icon layers to `apps/mobile/assets`, which
`apps/mobile/app.json` points at. Set the adaptive icon's `backgroundColor` to graphite, `#141517`.

## Colours

These match the [design reference](../../docs/design/README.md).

| Role   | Value     |
| ------ | --------- |
| Ground | `#141517` |
| Ink    | `#F4F2EE` |
| Ring   | `#F6B84D` |

Keep the ring saffron and the letters in a single ink. Don't retype the wordmark or redraw the
bite; use these files.

## Rebuilding

`generate.mjs` writes every file here from the font. Install its dependencies outside the repo and
pass that folder:

```sh
npm i --prefix /tmp/edo-brand --ignore-scripts opentype.js@1.3.4 @resvg/resvg-js@2.6.2 @fontsource/inter@5.2.8
node assets/brand/generate.mjs /tmp/edo-brand
```

Inter is licensed under the SIL Open Font License 1.1, which allows using its outlines in a logo.
