export function toPgVectorLiteral(vector: number[] | null | undefined) {
  if (!vector?.length || !vector.every((item) => Number.isFinite(item))) return null;
  return `[${vector.join(",")}]`;
}

export function isPgVectorUnavailable(error: unknown) {
  const record = error as { code?: unknown; message?: unknown; meta?: unknown };
  const code = typeof record?.code === "string" ? record.code : "";
  const message = [
    typeof record?.message === "string" ? record.message : "",
    typeof record?.meta === "string" ? record.meta : JSON.stringify(record?.meta ?? ""),
  ]
    .join(" ")
    .toLowerCase();

  return (
    ["42703", "42704", "42883", "42P01"].includes(code) ||
    message.includes("embeddingvector") ||
    message.includes("type \"vector\" does not exist") ||
    message.includes("operator does not exist") ||
    message.includes("extension \"vector\"")
  );
}
