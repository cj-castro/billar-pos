import { useTranslation } from 'react-i18next';
import { errorCode, errorKind, errorMessage, type ErrorKind } from '../utils/errorMessage';
import type { IconName } from '../theme/tokens';
import { EmptyState } from './EmptyState';

export interface ErrorStateProps {
  /** Thrown value; message/kind/code are derived (ApiError -> Spanish via errorMessage). */
  error?: unknown;
  title?: string;
  message?: string;
  code?: string;
  onRetry?: () => void;
  testID?: string;
}

const ICON: Record<ErrorKind, IconName> = {
  network: 'wifi-off',
  timeout: 'clock-alert-outline',
  unauthorized: 'lock-outline',
  forbidden: 'shield-alert-outline',
  notFound: 'magnify',
  conflict: 'alert-circle-outline',
  validation: 'alert-circle-outline',
  rateLimit: 'timer-sand',
  server: 'server-off',
  generic: 'alert-circle-outline',
};

/** Full-screen or inline error with retry. Pass `error` (preferred) or explicit title/message. */
export function ErrorState({ error, title, message, code, onRetry, testID = 'error-state' }: ErrorStateProps) {
  const { t } = useTranslation('mobile');
  const kind = error === undefined ? 'generic' : errorKind(error);
  const shownCode = code ?? (error === undefined ? undefined : errorCode(error));
  const body = message ?? (error === undefined ? t('errors.generic') : errorMessage(error));
  return (
    <EmptyState
      testID={testID}
      icon={ICON[kind]}
      tone={kind === 'forbidden' ? 'warning' : 'danger'}
      title={title ?? t('errors.title')}
      message={shownCode ? `${body}\n${t('errors.code', { code: shownCode })}` : body}
      action={onRetry ? { label: t('retry'), onPress: onRetry } : undefined}
    />
  );
}
