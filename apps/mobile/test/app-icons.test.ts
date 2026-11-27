import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const mobile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandPng = path.resolve(mobile, "../../assets/brand/png");

type AppJson = {
  expo: {
    icon: string;
    android: {
      adaptiveIcon: {
        backgroundColor: string;
        foregroundImage: string;
        backgroundImage: string;
        monochromeImage: string;
      };
    };
  };
};
const app = (JSON.parse(readFileSync(path.join(mobile, "app.json"), "utf8")) as AppJson).expo;
const adaptive = app.android.adaptiveIcon;

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const RGB = 2;
const RGBA = 6;

/** Size, bit depth and colour type from a PNG's IHDR chunk, and the types of all its chunks. */
function readPng(file: string) {
  const data = readFileSync(path.join(mobile, file));
  expect(data.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is a PNG`).toBe(true);
  const chunks: string[] = [];
  for (let at = 8; at < data.length; at += 12 + data.readUInt32BE(at)) {
    chunks.push(data.toString("latin1", at + 4, at + 8));
  }
  expect(chunks[0]).toBe("IHDR");
  return {
    width: data.readUInt32BE(16),
    height: data.readUInt32BE(20),
    bitDepth: data[24],
    colourType: data[25],
    chunks,
  };
}

/** An 8-bit RGB PNG with no transparent colour key, which the App Store requires of icons. */
function expectOpaque1024(file: string) {
  const png = readPng(file);
  expect(png).toMatchObject({ width: 1024, height: 1024, bitDepth: 8, colourType: RGB });
  expect(png.chunks, `${file} has no transparency chunk`).not.toContain("tRNS");
}

describe("app icons", () => {
  it("gives iOS an opaque 1024 px icon", () => {
    expectOpaque1024(app.icon);
  });

  it("gives Android an opaque background layer and RGBA foreground layers", () => {
    expectOpaque1024(adaptive.backgroundImage);
    for (const layer of [adaptive.foregroundImage, adaptive.monochromeImage]) {
      expect(readPng(layer)).toMatchObject({ width: 1024, height: 1024, colourType: RGBA });
    }
  });

  it("uses the design's graphite ground behind the adaptive icon", () => {
    expect(adaptive.backgroundColor).toBe("#141517");
  });

  it("ships the icons generated from assets/brand unchanged", () => {
    for (const file of [
      app.icon,
      adaptive.foregroundImage,
      adaptive.backgroundImage,
      adaptive.monochromeImage,
    ]) {
      const shipped = readFileSync(path.join(mobile, file));
      const source = readFileSync(path.join(brandPng, path.basename(file)));
      expect(shipped.equals(source), `${file} matches assets/brand/png`).toBe(true);
    }
  });
});
