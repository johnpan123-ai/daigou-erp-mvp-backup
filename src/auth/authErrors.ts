const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error ?? '');
};

export function formatLoginError(error: unknown): string {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes('invalid login credentials') || message.includes('invalid grant')) {
    return 'Email 或密碼錯誤，請重新確認。';
  }
  if (message.includes('failed to fetch') || message.includes('network') || message.includes('timeout')) {
    return '目前無法連線到登入服務，請確認網路後再試。';
  }
  if (message.includes('email not confirmed')) {
    return '此 Email 尚未完成驗證，請先查看驗證信。';
  }
  return '登入失敗，請稍後再試。';
}

export function formatRecoveryError(error: unknown): string {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes('expired') || message.includes('invalid') || message.includes('otp')) {
    return '密碼重設連結已失效或無效，請重新申請。';
  }
  if (message.includes('failed to fetch') || message.includes('network') || message.includes('timeout')) {
    return '目前無法連線到密碼服務，請確認網路後再試。';
  }
  if (message.includes('password')) {
    return '新密碼不符合安全要求，請調整後再試。';
  }
  return '無法完成密碼重設，請重新申請連結。';
}

export function formatPasswordResetRequestError(error: unknown): string {
  const message = getErrorMessage(error).toLowerCase();
  if (message.includes('rate limit')) return '寄送次數過多，請稍後再試。';
  if (message.includes('failed to fetch') || message.includes('network') || message.includes('timeout')) {
    return '目前無法連線到密碼服務，請確認網路後再試。';
  }
  return '傳送重設信件失敗，請稍後再試。';
}
