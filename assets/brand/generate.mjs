// Builds Edo's logo files: the bitten ring, and the "edo" wordmark set in Inter Bold with the ring
// as its "o". See README.md in this folder.
//
// Usage: node assets/brand/generate.mjs <deps-dir>
// <deps-dir> holds opentype.js@1.3.4, @resvg/resvg-js@2.6.2 and @fontsource/inter@5.2.8, e.g.
//   npm i --prefix /tmp/edo-brand --ignore-scripts opentype.js@1.3.4 @resvg/resvg-js@2.6.2 @fontsource/inter@5.2.8
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const deps = process.argv[2];
if (!deps) {
  console.error("usage: node assets/brand/generate.mjs <deps-dir>");
  process.exit(1);
}
const require = createRequire(path.join(path.resolve(deps), "package.json"));
const opentype = require("opentype.js");
const { Resvg } = require("@resvg/resvg-js");

const here = path.dirname(fileURLToPath(import.meta.url));
const appAssets = path.join(here, "../../apps/mobile/assets");
const font = opentype.loadSync(
  path.join(
    path.dirname(require.resolve("@fontsource/inter/package.json")),
    "files/inter-latin-700-normal.woff",
  ),
);

// The app's palette from docs/design/README.md: graphite ground, warm white ink, saffron accent.
const ground = "#141517";
const ink = "#F4F2EE";
const saffron = "#F6B84D";

// The ring, centred on (0, 0): radius 260 and width 136, so it spans 328 either side.
const RING_R = 260;
const RING_W = 136;
const RING_OUTER = RING_R + RING_W / 2;
// Three overlapping circles take the bite out of its upper right.
const BITE = [
  [240, -240, 105],
  [135, -318, 70],
  [318, -135, 70],
];

/** The bitten ring in `color`, centred on (cx, cy) with an outer diameter of `diameter`. */
function ring(cx, cy, diameter, color) {
  // Each file holds one ring, so a fixed mask id is enough.
  const id = "edo-bite";
  const scale = diameter / (2 * RING_OUTER);
  const bite = BITE.map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}" fill="#000"/>`);
  return (
    `<g transform="translate(${n(cx)} ${n(cy)}) scale(${n(scale, 4)})">` +
    `<mask id="${id}" maskUnits="userSpaceOnUse" x="-400" y="-400" width="800" height="800">` +
    `<rect x="-400" y="-400" width="800" height="800" fill="#fff"/>${bite.join("")}</mask>` +
    `<circle r="${RING_R}" fill="none" stroke="${color}" stroke-width="${RING_W}" mask="url(#${id})"/>` +
    "</g>"
  );
}

const n = (value, digits = 2) => String(Number(value.toFixed(digits)));
const svg = (viewBox, body) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}"><title>Edo</title>${body}</svg>\n`;
const square = (body, fill, rx = 0) =>
  svg(
    "0 0 1024 1024",
    `${fill ? `<rect width="1024" height="1024"${rx ? ` rx="${rx}"` : ""} fill="${fill}"/>` : ""}${body}`,
  );

/** The ring at its icon size, centred on the 1024 canvas. */
const iconRing = (color, diameter = 2 * RING_OUTER) => ring(512, 512, diameter, color);

/** "ed" in Inter Bold followed by the ring, sized and spaced like Inter's own "o". */
function wordmark() {
  const size = 100;
  const glyphs = font.stringToGlyphs("edo");
  const kern = (a, b) => (font.getKerningValue(a, b) * size) / font.unitsPerEm;
  const advance = (g) => (g.advanceWidth * size) / font.unitsPerEm;
  const [e, d, o] = glyphs;
  const dX = advance(e) + kern(e, d);
  const oX = dX + advance(d) + kern(d, o);
  const word = font.getPath("ed", 0, 0, size, { kerning: true });
  const oBox = o.getPath(oX, 0, size).getBoundingBox();
  const diameter = oBox.y2 - oBox.y1;
  const cx = (oBox.x1 + oBox.x2) / 2;
  const cy = (oBox.y1 + oBox.y2) / 2;
  const w = word.getBoundingBox();
  const pad = 4;
  const x1 = w.x1 - pad;
  const y1 = Math.min(w.y1, oBox.y1) - pad;
  const x2 = cx + diameter / 2 + pad;
  const y2 = Math.max(w.y2, oBox.y2) + pad;
  return svg(
    [x1, y1, x2 - x1, y2 - y1].map((v) => n(v, 1)).join(" "),
    `<path d="${word.toPathData(2)}" fill="${ink}"/>${ring(cx, cy, diameter, saffron)}`,
  );
}

const written = [];
const out = (file, data) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  written.push(path.relative(process.cwd(), file));
};
const png = (svgText, size) =>
  new Resvg(svgText, { fitTo: { mode: "width", value: size } }).render().asPng();

/** An opaque image as an RGB PNG with no alpha channel, which the App Store requires of icons. */
function opaquePng(svgText, size) {
  const image = new Resvg(svgText, { fitTo: { mode: "width", value: size } }).render();
  const { width, height, pixels } = image;
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    for (let x = 0; x < width; x++) {
      const from = (y * width + x) * 4;
      if (pixels[from + 3] !== 255) throw new Error(`${svgText.slice(0, 40)}… is not opaque`);
      pixels.copy(raw, row + 1 + x * 3, from, from + 3);
    }
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8-bit RGB, no interlace
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// Vector sources.
const brand = (name) => path.join(here, name);
out(brand("icon.svg"), square(iconRing(saffron), ground, 228));
out(
  brand("mark.svg"),
  svg(
    `${-RING_OUTER} ${-RING_OUTER} ${2 * RING_OUTER} ${2 * RING_OUTER}`,
    ring(0, 0, 2 * RING_OUTER, saffron),
  ),
);
out(brand("wordmark.svg"), wordmark());

// App icons. Each is written to png/ and to apps/mobile/assets, which app.json points at.
const icon = (name, data) => {
  out(brand(`png/${name}`), data);
  out(path.join(appAssets, name), data);
};
// iOS masks the corners itself and needs an opaque square.
icon("icon.png", opaquePng(square(iconRing(saffron), ground), 1024));
// Android adaptive icons: keep the ring inside the 66/108 safe circle (626 px of 1024).
const safe = 0.95 * (66 / 108) * 1024;
icon("android-icon-foreground.png", png(square(iconRing(saffron, safe)), 1024));
icon("android-icon-background.png", opaquePng(square("", ground), 1024));
icon("android-icon-monochrome.png", png(square(iconRing("#FFFFFF", safe)), 1024));
// Web favicon and a transparent splash mark for a graphite splash colour.
out(brand("png/favicon.png"), png(square(iconRing(saffron), ground, 228), 48));
out(brand("png/splash-icon.png"), png(square(iconRing(saffron, 920)), 1024));

for (const file of written) console.log(file);
