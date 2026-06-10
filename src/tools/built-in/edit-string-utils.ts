export function normalizeQuotes(text: string): string {
  return text
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'");
}

export function findActualString(
  fileContent: string,
  searchString: string,
): string | null {
  if (fileContent.includes(searchString)) return searchString;

  const normalizedSearch = normalizeQuotes(searchString);
  const normalizedFile = normalizeQuotes(fileContent);
  const searchIndex = normalizedFile.indexOf(normalizedSearch);
  if (searchIndex !== -1) {
    return fileContent.substring(
      searchIndex,
      searchIndex + searchString.length,
    );
  }
  return null;
}

export function preserveQuoteStyle(
  requestedOldString: string,
  actualOldString: string,
  requestedNewString: string,
): string {
  let next = requestedNewString;
  if (!requestedOldString.includes('"') && !requestedOldString.includes("'")) return next;
  if (actualOldString.includes("“") || actualOldString.includes("”")) {
    let open = true;
    next = next.replace(/"/g, () => {
      const replacement = open ? "“" : "”";
      open = !open;
      return replacement;
    });
  }
  if (actualOldString.includes("‘") || actualOldString.includes("’")) {
    let open = true;
    next = next.replace(/'/g, () => {
      const replacement = open ? "‘" : "’";
      open = !open;
      return replacement;
    });
  }
  return next;
}
