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

/** Width, height and colour type from a PNG's IHDR chunk. */
function pngHeader(file: string) {
  const data = readFileSync(path.join(mobile, file));
  expect(data.subarray(0, 8).equals(PNG_SIGNATURE), `${file} is a PNG`).toBe(true);
  expect(data.toString("latin1", 12, 16)).toBe("IHDR");
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20), colourType: data[25] };
}

describe("app icons", () => {
  it("gives iOS an opaque 1024 px icon, which the App Store requires", () => {
    expect(pngHeader(app.icon)).toEqual({ width: 1024, height: 1024, colourType: RGB });
  });

  it("gives Android an opaque background and transparent foreground layers", () => {
    expect(pngHeader(adaptive.backgroundImage)).toEqual({
      width: 1024,
      height: 1024,
      colourType: RGB,
    });
    for (const layer of [adaptive.foregroundImage, adaptive.monochromeImage]) {
      expect(pngHeader(layer)).toEqual({ width: 1024, height: 1024, colourType: RGBA });
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
