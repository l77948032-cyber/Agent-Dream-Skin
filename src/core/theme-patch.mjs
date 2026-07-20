function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function mergeThemePatch(target, patch) {
  if (!isRecord(patch)) return structuredClone(patch);
  const result = isRecord(target) ? structuredClone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else if (isRecord(value)) result[key] = mergeThemePatch(result[key], value);
    else result[key] = structuredClone(value);
  }
  return result;
}
