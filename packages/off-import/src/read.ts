import { createReadStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import { type ParsedProduct, readOpenFoodFactsProduct } from "./format.ts";

export interface ExportCounts {
  accepted: number;
  rejected: number;
  skipped: number;
}

export async function readOpenFoodFactsExport(
  inputPath: string,
  release: string,
  add: (product: ParsedProduct) => boolean,
): Promise<ExportCounts> {
  const counts = { accepted: 0, rejected: 0, skipped: 0 };
  const consume = (line: string) => {
    if (!line.trim()) return;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      counts.rejected += 1;
      return;
    }
    const product = readOpenFoodFactsProduct(row, release);
    if (product === "outside-scope") counts.skipped += 1;
    else if (!product || !add(product)) counts.rejected += 1;
    else counts.accepted += 1;
  };
  await pipeline(createReadStream(inputPath), createGunzip(), async (stream) => {
    const decoder = new StringDecoder("utf8");
    let rest = "";
    for await (const chunk of stream) {
      const text = rest + decoder.write(chunk);
      let start = 0;
      for (let end = text.indexOf("\n"); end !== -1; end = text.indexOf("\n", start)) {
        consume(text.slice(start, end));
        start = end + 1;
      }
      rest = text.slice(start);
    }
    consume(rest + decoder.end());
  });
  return counts;
}
