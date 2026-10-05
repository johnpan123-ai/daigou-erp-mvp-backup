/** Lookup keys only. Never change durable WACA feature / order identity. */
const width = (value: string) => value.replace(/[｡-ﾟ]+/gu, s => s.normalize('NFKC'))
  .replace(/[！-～]/gu, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
  .replace(/[a-z]/gu, c => c.toUpperCase()).trim();

export function wacaProductName(value: string): string {
  let text = width(value);
  // Only leading selling metadata, not years/months/version words inside the product.
  const prefix = /^(?:[【[]小河馬(?:日本)?代購[】\]]|預購|現貨|日本代購|現地代購|預約|\d{2,4}年\d{1,2}月)\s*/u;
  while (prefix.test(text)) text = text.replace(prefix, '').trim();
  return text.replace(/[【】「」『』[\]（）()、，,。・·]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

export const wacaProductKey = (value: string): string => wacaProductName(value).replace(/\s+/gu, '');
export const wacaAliasKey = (value: string): string => wacaProductKey(value).replace(/代理版/gu, '');
export const wacaProductTokens = (value: string): string =>
  wacaProductName(value).split(' ').filter(Boolean).sort().join('\u001f');

export function wacaSpecKey(value: string): string {
  return width(value).replace(/[【「『[（]/gu, '(').replace(/[】」』\]）]/gu, ')')
    .replace(/\s*[/／]\s*/gu, ' / ').replace(/\s+/gu, ' ').trim();
}

export const wacaSourceSpecKeys = (spec1: string, spec2: string): string[] => {
  const parts = [spec1, spec2].map(wacaSpecKey).filter(Boolean);
  return parts.length ? [...new Set([parts.join(' '), parts.join(' / ')])] : [];
};
