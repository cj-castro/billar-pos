import { useLocalSearchParams } from 'expo-router';
import { DraftScreen } from '../../../../src/features/waiter/draft/DraftScreen';

export default function Screen() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  return <DraftScreen ticketId={ticketId} />;
}
