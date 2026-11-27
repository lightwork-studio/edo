import type { PackagedFood } from "@edo/core";
import type { DiaryStore, PackagedFoodCache } from "@edo/storage";
import { fetch } from "expo/fetch";
import { useEffect, useState } from "react";
import { type BarcodeResult, lookupPackagedFood, retainedProducts } from "./barcode";
import { BarcodeScreen } from "./barcode-screen";
import { httpsOrigin } from "./catalog-origin";
import type { Strings } from "./strings";

const origin = httpsOrigin(process.env.EXPO_PUBLIC_EDO_CATALOG_ORIGIN);

export interface BarcodeState {
  code: string;
  result: BarcodeResult | null;
}

export function BarcodeEntry({
  t,
  locale,
  date,
  today,
  diary,
  cache,
  initial,
  onPick,
  onBack,
}: {
  t: Strings;
  locale: string;
  date: string;
  today: string;
  diary: DiaryStore;
  /** Undefined while opening, null when the independent cache is unavailable. */
  cache: PackagedFoodCache | null | undefined;
  initial: BarcodeState;
  onPick: (food: PackagedFood, state: BarcodeState) => void;
  onBack: () => void;
}) {
  const [submitted, setSubmitted] = useState<{ code: string; lookupCode: string } | null>(null);
  const [resolved, setResolved] = useState<{
    submit: NonNullable<typeof submitted>;
    result: BarcodeResult;
  }>();
  useEffect(() => {
    if (!submitted || cache === undefined) return;
    const controller = new AbortController();
    void lookupPackagedFood({
      code: submitted.lookupCode,
      alternateCode: submitted.code,
      origin,
      cache,
      keep: () => retainedProducts(diary, today),
      signal: controller.signal,
      request: fetch,
    }).then((result) => {
      if (!controller.signal.aborted) setResolved({ submit: submitted, result });
    });
    return () => controller.abort();
  }, [submitted, cache, diary, today]);

  const code = submitted?.code ?? initial.code;
  const result = submitted
    ? resolved?.submit === submitted
      ? resolved.result
      : null
    : initial.result;
  return (
    <BarcodeScreen
      t={t}
      locale={locale}
      date={date}
      code={code}
      result={result}
      pending={submitted !== null && result === null}
      onSubmit={(code, lookupCode = code) => setSubmitted({ code, lookupCode })}
      onPick={(food) => onPick(food, { code, result })}
      onBack={onBack}
    />
  );
}
