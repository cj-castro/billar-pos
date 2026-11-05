import { useTranslation } from 'react-i18next';
import { PendingScreen } from '../../../src/components/PendingScreen';

// SCR-A-01 placeholder: replace with the real screen (see docs/mobile/implementation/SCREEN_TO_CODE_MAPPING.md).
export default function Screen() {
  const { t } = useTranslation('mobile');
  return <PendingScreen id="SCR-A-01" title={t('screens.system')} tabs />;
}
