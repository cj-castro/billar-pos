import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { EmptyState } from './EmptyState';
import { ConnectionPill } from './ConnectionPill';
import { OfflineBanner } from './OfflineBanner';
import { ScreenHeader } from './ScreenHeader';
import { ScreenScaffold } from './ScreenScaffold';

/**
 * Placeholder body for a P0 screen that feature agents have not implemented yet.
 * Replace the whole file content with the real screen; keep the default export.
 */
export function PendingScreen({ id, title, back, tabs }: { id: string; title: string; back?: boolean; tabs?: boolean }) {
  const { t } = useTranslation('mobile');
  const router = useRouter();
  return (
    <ScreenScaffold
      testID={`screen-${id}`}
      edges={tabs ? ['top'] : undefined}
      padded={false}
      header={<ScreenHeader title={title} subtitle={id} onBack={back ? () => router.back() : undefined} right={<ConnectionPill />} />}
      banner={<OfflineBanner />}
    >
      <EmptyState icon="hammer-wrench" title={t('pending')} message={t('pendingBody')} testID="pending" />
    </ScreenScaffold>
  );
}
