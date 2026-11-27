import type { PackagedFood } from "@edo/core";
import type { BarcodeSettings, CameraView as ExpoCameraView } from "expo-camera";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AppState,
  Keyboard,
  Linking,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { type BarcodeResult, openFoodFactsLicenseUrl } from "./barcode";
import type { Strings } from "./strings";
import { colors, DetailHeader, displayNumber, Notice, nutrientValue, styles } from "./ui";

const productCodes: BarcodeSettings = {
  barcodeTypes: ["ean13", "ean8", "upc_a", "upc_e", "itf14"],
};
const basisLabels = {
  "per-100-g": "per100g",
  "per-100-ml": "per100ml",
  "per-portion": "perPortion",
} as const;

export function BarcodeScreen({
  t,
  locale,
  date,
  code,
  result,
  pending,
  onSubmit,
  onPick,
  onBack,
}: {
  t: Strings;
  locale: string;
  date: string;
  code: string;
  result: BarcodeResult | null;
  pending: boolean;
  onSubmit: (code: string, cameraUpcE: boolean) => void;
  onPick: (food: PackagedFood) => void;
  onBack: () => void;
}) {
  const [digits, setDigits] = useState(code);
  const [preview, setPreview] = useState<{ view: typeof ExpoCameraView; session: object } | null>(
    null,
  );
  const [opening, setOpening] = useState(false);
  const [cameraError, setCameraError] = useState<"denied" | "unavailable" | null>(null);
  const isForeground =
    AppState.currentState !== "inactive" && AppState.currentState !== "background";
  const [foreground, setForeground] = useState(isForeground);
  const foregroundRef = useRef(isForeground);
  const cameraSession = useRef<object | null>(null);
  const submitting = useRef(false);

  useLayoutEffect(() => {
    const appState = AppState.addEventListener("change", (state) => {
      foregroundRef.current = state === "active";
      setForeground(foregroundRef.current);
    });
    return () => {
      appState.remove();
      cameraSession.current = null;
    };
  }, []);

  useEffect(() => {
    if (!pending && result) submitting.current = false;
  }, [pending, result]);

  function closeCamera() {
    cameraSession.current = null;
    setPreview(null);
    setOpening(false);
  }

  async function openCamera() {
    if (cameraSession.current || submitting.current || pending) return;
    const session = {};
    cameraSession.current = session;
    setOpening(true);
    setCameraError(null);
    Keyboard.dismiss();
    try {
      const { Camera, CameraView } = await import("expo-camera");
      if (cameraSession.current !== session) return;
      const existing = await Camera.getCameraPermissionsAsync();
      if (cameraSession.current !== session) return;
      const permission =
        existing.granted || !existing.canAskAgain
          ? existing
          : await Camera.requestCameraPermissionsAsync();
      if (cameraSession.current !== session) return;
      if (!permission.granted) {
        closeCamera();
        setCameraError("denied");
        return;
      }
      setPreview({ view: CameraView, session });
      setOpening(false);
    } catch {
      if (cameraSession.current !== session) return;
      closeCamera();
      setCameraError("unavailable");
    }
  }

  function submit(value: string, compressedUpc = false) {
    const entered = value.trim();
    if (!entered || pending || submitting.current) return;
    submitting.current = true;
    closeCamera();
    setDigits(entered);
    Keyboard.dismiss();
    onSubmit(entered, compressedUpc);
  }

  function back() {
    closeCamera();
    onBack();
  }

  const CameraView = preview?.view;
  const currentResult = digits.trim() === code ? result : null;
  const lookupDisabled = pending || !digits.trim();

  return (
    <>
      <DetailHeader title={t.scanBarcode} subtitle={date} back={t.back} onBack={back} />
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.content}>
        {preview && CameraView && foreground && (
          <View style={local.preview}>
            <CameraView
              style={StyleSheet.absoluteFill}
              facing="back"
              barcodeScannerSettings={productCodes}
              onBarcodeScanned={({ data, type }) => {
                if (cameraSession.current === preview.session && foregroundRef.current)
                  submit(data, type === "upc_e");
              }}
              onMountError={() => {
                if (cameraSession.current !== preview.session) return;
                closeCamera();
                setCameraError("unavailable");
              }}
            />
            <View importantForAccessibility="no" pointerEvents="none" style={local.reticle} />
          </View>
        )}
        {preview && <Text style={styles.body}>{t.barcodeCameraGuide}</Text>}
        {opening && <Notice text={t.barcodeCameraOpening} pending />}
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: pending }}
          disabled={pending}
          onPress={preview || opening ? closeCamera : () => void openCamera()}
          style={[styles.card, local.secondary, pending && styles.faded]}
        >
          <Text style={styles.actionText}>
            {preview || opening ? t.closeBarcodeCamera : t.openBarcodeCamera}
          </Text>
        </Pressable>
        {cameraError && (
          <Text accessibilityLiveRegion="polite" style={styles.meta}>
            {cameraError === "denied" ? t.barcodeCameraDenied : t.barcodeCameraUnavailable}
          </Text>
        )}
        <View style={styles.card}>
          <Text style={styles.meta}>{t.productBarcode}</Text>
          <TextInput
            accessibilityLabel={t.productBarcode}
            placeholder={t.enterBarcode}
            placeholderTextColor={colors.muted}
            value={digits}
            onChangeText={setDigits}
            editable={!pending}
            inputMode="numeric"
            autoCorrect={false}
            returnKeyType="search"
            onSubmitEditing={() => submit(digits)}
            style={local.input}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: lookupDisabled }}
            disabled={lookupDisabled}
            onPress={() => submit(digits)}
            style={({ pressed }) => [
              styles.primary,
              lookupDisabled && styles.faded,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.primaryText}>{t.lookUpBarcode}</Text>
          </Pressable>
        </View>
        {pending && <Notice text={t.lookingUpBarcode} pending />}
        {!pending && currentResult && (
          <BarcodeResults
            result={currentResult}
            t={t}
            locale={locale}
            onPick={onPick}
            onSearch={back}
          />
        )}
      </ScrollView>
    </>
  );
}

function BarcodeResults({
  result,
  locale,
  t,
  onPick,
  onSearch,
}: {
  result: BarcodeResult;
  locale: string;
  t: Strings;
  onPick: (food: PackagedFood) => void;
  onSearch: () => void;
}) {
  const [showLicenseUrl, setShowLicenseUrl] = useState(false);
  if (result.status !== "found") {
    const copy = {
      invalid: t.invalidBarcode,
      "not-found": t.barcodeNotFound,
      unavailable: t.barcodeUnavailable,
      "rate-limited": t.barcodeRateLimited,
    };
    const canSearch = result.status === "not-found" || result.status === "unavailable";
    return (
      <Notice
        text={copy[result.status]}
        action={canSearch ? { label: t.search, onPress: onSearch } : undefined}
      />
    );
  }
  return (
    <>
      {result.products.length > 1 && (
        <Text accessibilityRole="header" accessibilityLiveRegion="polite" style={styles.title}>
          {t.barcodeMatches}
        </Text>
      )}
      {result.cached && <Text style={styles.meta}>{t.barcodeCached}</Text>}
      {result.products.map((food) => (
        <Pressable
          key={food.id.sourceId}
          accessibilityRole="button"
          onPress={() => onPick(food)}
          style={({ pressed }) => [styles.card, local.product, pressed && styles.pressed]}
        >
          <Text style={styles.title}>{food.name}</Text>
          {food.alternateName && food.alternateName !== food.name && (
            <Text style={styles.body}>{food.alternateName}</Text>
          )}
          <Text style={styles.meta}>{nutritionSummary(food, t, locale)}</Text>
          <Text style={styles.meta}>
            {t.productBarcode} {food.barcode}
          </Text>
        </Pressable>
      ))}
      <View style={local.credit}>
        <Text style={styles.meta}>{t.openFoodFactsCredit}</Text>
        {showLicenseUrl ? (
          <Text selectable style={styles.meta}>
            {openFoodFactsLicenseUrl}
          </Text>
        ) : (
          <Pressable
            accessibilityRole="link"
            onPress={() =>
              void Linking.openURL(openFoodFactsLicenseUrl).catch(() => setShowLicenseUrl(true))
            }
            style={local.license}
          >
            <Text style={styles.actionText}>{t.openFoodFactsLicense}</Text>
          </Pressable>
        )}
      </View>
    </>
  );
}

function nutritionSummary(food: PackagedFood, t: Strings, locale: string): string {
  const nutrition = food.nutrition;
  if (!nutrition) return t.barcodeNutritionUnavailable;
  const { basis, nutrients, portionSize } = nutrition;
  const details = [
    nutrients.kcal === null
      ? t.barcodeCaloriesUnavailable
      : nutrientValue(nutrients.kcal, locale, "kcal"),
    t[basisLabels[basis]],
  ];
  if (basis === "per-portion" && portionSize) {
    details[1] += ` (${displayNumber(portionSize.amount, locale)} ${portionSize.unit})`;
  }
  if (food.preparation === "prepared") details.push(t.barcodePrepared);
  if (food.preparation === "as-sold") details.push(t.barcodeAsSold);
  return details.join(" · ");
}

const local = StyleSheet.create({
  preview: {
    height: 224,
    borderRadius: 20,
    backgroundColor: colors.surface,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  reticle: {
    width: "78%",
    height: "44%",
    borderWidth: 2,
    borderColor: colors.accent,
    borderRadius: 16,
  },
  secondary: { alignItems: "center", justifyContent: "center" },
  input: {
    minHeight: 52,
    backgroundColor: colors.field,
    borderRadius: 14,
    color: colors.text,
    fontSize: 17,
    paddingHorizontal: 12,
    fontVariant: ["tabular-nums"],
  },
  product: { minHeight: 52, gap: 6 },
  credit: { alignItems: "flex-start", paddingHorizontal: 4, paddingTop: 4 },
  license: { minHeight: 44, justifyContent: "center" },
});
