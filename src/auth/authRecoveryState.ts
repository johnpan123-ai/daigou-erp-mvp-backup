const RECOVERY_SESSION_KEY = 'erp_password_recovery_active';
const LOGIN_INTENT_KEY = 'erp_cloud_login_intent';

export const markRecoverySession = (): void => {
  sessionStorage.setItem(RECOVERY_SESSION_KEY, 'true');
};

export const hasRecoverySession = (): boolean => (
  sessionStorage.getItem(RECOVERY_SESSION_KEY) === 'true'
);

export const clearRecoverySession = (): void => {
  sessionStorage.removeItem(RECOVERY_SESSION_KEY);
};

export const markCloudLoginIntent = (): void => {
  sessionStorage.setItem(LOGIN_INTENT_KEY, 'true');
};

export const consumeCloudLoginIntent = (): boolean => {
  const active = sessionStorage.getItem(LOGIN_INTENT_KEY) === 'true';
  sessionStorage.removeItem(LOGIN_INTENT_KEY);
  return active;
};

export const clearCloudLoginIntent = (): void => {
  sessionStorage.removeItem(LOGIN_INTENT_KEY);
};
