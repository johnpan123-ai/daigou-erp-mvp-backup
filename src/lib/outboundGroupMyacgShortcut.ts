export const MYACG_MEMBER_CENTER_URL = 'https://www.myacg.com.tw/member_center_v2.php?e_id=1&list_type=3';

type ClipboardWriter = (text: string) => Promise<void>;
type ExternalPageOpener = (url: string, target: string, features: string) => unknown;

const writeClipboard: ClipboardWriter = (text) => navigator.clipboard.writeText(text);
const openExternalPage: ExternalPageOpener = (url, target, features) => window.open(url, target, features);

export const copyOutboundGroupNameAndOpenMyacg = (
  groupName: string,
  opener: ExternalPageOpener = openExternalPage,
  writer: ClipboardWriter = writeClipboard,
) => {
  // Begin Clipboard access while this click still owns user activation, then open synchronously.
  let clipboardAttempt: Promise<void>;
  try {
    clipboardAttempt = writer(groupName);
  } catch (error) {
    clipboardAttempt = Promise.reject(error);
  }
  opener(MYACG_MEMBER_CENTER_URL, '_blank', 'noopener,noreferrer');
  return clipboardAttempt;
};
