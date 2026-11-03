export const MYACG_MEMBER_CENTER_URL = 'https://www.myacg.com.tw/member_center_v2.php';

type ClipboardWriter = (text: string) => Promise<void>;
type ExternalPageOpener = (url: string, target: string, features: string) => unknown;

const writeClipboard: ClipboardWriter = (text) => navigator.clipboard.writeText(text);
const openExternalPage: ExternalPageOpener = (url, target, features) => window.open(url, target, features);

export const copyOutboundGroupNameToClipboard = (
  groupName: string,
  writer: ClipboardWriter = writeClipboard,
) => writer(groupName);

export const copyOutboundGroupNameAndOpenMyacg = (
  groupName: string,
  opener: ExternalPageOpener = openExternalPage,
  writer: ClipboardWriter = writeClipboard,
) => {
  // Start Clipboard while the ERP tab still has focus, but do not await it before opening the new tab.
  const clipboardAttempt = writer(groupName);
  opener(MYACG_MEMBER_CENTER_URL, '_blank', 'noopener,noreferrer');
  return clipboardAttempt;
};
