/** Values used by the concrete OAuth provider include nested Dates and Maps. */
function encode(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (value instanceof Map)
    return {
      $map: [...value].map(([key, item]) => [encode(key), encode(item)]),
    };
  if (Array.isArray(value)) return value.map(encode);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, encode(item)]),
    );
  return value;
}
function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record.$date === "string")
      return new Date(record.$date);
    if (Object.keys(record).length === 1 && Array.isArray(record.$map))
      return new Map(
        record.$map.map((entry: unknown) => {
          if (!Array.isArray(entry) || entry.length !== 2)
            throw new Error("InvalidStoredMap");
          return [decode(entry[0]), decode(entry[1])];
        }),
      );
    return Object.fromEntries(
      Object.entries(record).map(([key, item]) => [key, decode(item)]),
    );
  }
  return value;
}
export const serialize = (value: unknown): string =>
  JSON.stringify(encode(value));
export const deserialize = (value: string): unknown =>
  decode(JSON.parse(value) as unknown);
