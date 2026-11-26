import { useLocalSearchParams } from 'expo-router';
import { PayScreen } from '../../../../src/features/waiter/pay/PayScreen';

export default function Screen() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  return <PayScreen ticketId={String(ticketId)} />;
}
