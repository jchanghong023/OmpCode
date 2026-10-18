function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** OMP owns the saved display body; never rebuild an old read from the current file. */
export function ompReadOutput(details: unknown): string | undefined {
  const record = object(details);
  const display = object(record?.displayContent);
  if (typeof display?.text !== "string") return undefined;
  const source = object(object(record?.meta)?.source);
  return typeof source?.value === "string" && source.value
    ? `[${source.value}]\n${display.text}`
    : display.text;
}
