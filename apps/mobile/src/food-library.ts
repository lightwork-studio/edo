export function matchLibraryName(query: string, locale: string) {
  const fold = (text: string) =>
    text
      .toLocaleLowerCase(locale)
      .normalize("NFD")
      .replace(/\p{Mark}/gu, "");
  const trimmed = fold(query).trim();
  if (!trimmed) return undefined;
  const terms = trimmed.split(/\s+/u);
  return (name: string) => {
    const foldedName = fold(name);
    return terms.every((term) => foldedName.includes(term));
  };
}
