import { useEffect, useState } from "react";

export function useDatabase<T extends { close(): Promise<void> }>(
  open: () => Promise<T>,
  openOnMount = true,
) {
  const [attempt, setAttempt] = useState(openOnMount ? 0 : null);
  const [result, setResult] = useState<{ attempt: number; value: T | "error" }>();

  useEffect(() => {
    if (attempt === null) return;
    let active = true;
    let connection: T | undefined;
    void open()
      .then(async (opened) => {
        if (!active) {
          await opened.close();
          return;
        }
        connection = opened;
        setResult({ attempt, value: opened });
      })
      .catch(() => {
        if (active) setResult({ attempt, value: "error" });
      });

    return () => {
      active = false;
      void connection?.close().catch(() => {});
    };
  }, [attempt, open]);

  return {
    value: result && result.attempt === attempt ? result.value : null,
    start: () => setAttempt((current) => current ?? 0),
    retry: () => setAttempt((current) => (current ?? 0) + 1),
  };
}
