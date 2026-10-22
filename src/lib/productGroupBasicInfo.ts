/** Only absolute http(s) URLs are ever rendered as a link; anything else is treated as "no link". */
export const safeOfficialUrl = (value: string | null | undefined): string | null => {
  const raw = (value ?? '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
};
