export class ToolError extends Error {
  constructor(code, message, details = undefined, options = undefined) {
    super(message, options);
    this.name = "ToolError";
    this.code = code;
    this.details = details;
  }
}

export function asToolError(error, fallbackCode = "INTERNAL_ERROR") {
  if (error instanceof ToolError) return error;
  return new ToolError(fallbackCode, error?.message || String(error), undefined, { cause: error });
}

export function errorEnvelope(error) {
  const normalized = asToolError(error);
  return {
    ok: false,
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.details === undefined ? {} : { details: normalized.details }),
    },
  };
}
