const byKey = (
  [left]: [string, unknown],
  [right]: [string, unknown],
): number => {
  if (left < right) return -1;
  return left > right ? 1 : 0;
};

const unsupported = (value: unknown): never => {
  throw new TypeError(
    `Retained PLC evidence must be a JSON value, not ${typeof value}`,
  );
};

/** Key-sorted JSON used to compare and retain PLC evidence. Accepts JSON
 * values only: `undefined`, functions, symbols, bigints and array holes are
 * refused, because their text would not parse back or would compare equal to
 * a different value. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${Array.from(value, (item, index) =>
      index in value ? canonicalJson(item) : unsupported(undefined),
    ).join(",")}]`;
  if (typeof value === "object" && value !== null)
    return `{${Object.entries(value)
      .sort(byKey)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  const text: string | undefined =
    typeof value === "bigint" ? undefined : JSON.stringify(value);
  return text ?? unsupported(value);
}
