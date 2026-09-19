export class ClipboardWriteError extends Error {
  readonly code = 'CLIPBOARD_WRITE_FAILED';

  constructor() {
    super('無法寫入剪貼簿，請允許剪貼簿權限後再試。');
    this.name = 'ClipboardWriteError';
  }
}

const writeWithLegacySelection = (text: string): boolean => {
  if (typeof document === 'undefined' || typeof document.execCommand !== 'function') return false;
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  textarea.setSelectionRange(0, textarea.value.length);
  try {
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
};

export const writeTextToClipboard = async (text: string): Promise<void> => {
  if (!text) throw new ClipboardWriteError();
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    // A denied or unavailable modern Clipboard API may still have a safe,
    // user-gesture-backed legacy path. Never expose the raw browser error.
  }

  if (!writeWithLegacySelection(text)) throw new ClipboardWriteError();
};
