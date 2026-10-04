export type StructuredError = { code?: string; message: string; details?: string; hint?: string };

/** Never stringify arbitrary objects: recursive envelopes, cycles and arrays are
 * accepted, while credentials and row-bearing DETAIL are not rendered by UI. */
export function formatStructuredError(cause: unknown): StructuredError {
  const seen = new Set<object>();
  const scalar = (value: unknown): string | undefined => typeof value === 'string' && value.trim()
    ? value.trim() : typeof value === 'number' ? String(value) : undefined;
  const visit = (value: unknown, depth: number): StructuredError | undefined => {
    if (depth > 8) return undefined;
    const text = scalar(value);
    if (text) return { message: text };
    if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);
    if (Array.isArray(value)) {
      const errors = value.map(item => visit(item, depth + 1)).filter((item): item is StructuredError => !!item);
      return errors.length ? { ...errors[0], message: errors.map(item => item.message).join('；') } : undefined;
    }
    const envelope = value as Record<string, unknown>;
    const nested = visit(envelope.error ?? envelope.cause ?? envelope.errors, depth + 1);
    const embeddedMessage = visit(envelope.message, depth + 1);
    const message = scalar(envelope.message) ?? embeddedMessage?.message ?? nested?.message;
    const code = scalar(envelope.code) ?? embeddedMessage?.code ?? nested?.code;
    if (!message && !code) return undefined;
    return { code, message: message ?? '服務回傳未識別的錯誤。',
      details: scalar(envelope.details) ?? embeddedMessage?.details ?? nested?.details,
      hint: scalar(envelope.hint) ?? embeddedMessage?.hint ?? nested?.hint };
  };
  return visit(cause, 0) ?? { message: '發生未識別的錯誤，請重新讀取並查看技術資訊。' };
}
