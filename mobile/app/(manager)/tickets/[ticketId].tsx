import { useLocalSearchParams } from 'expo-router';
import { TicketDetailScreen } from '../../../src/features/waiter/ticket/TicketDetailScreen';

/** SCR-W-02 in manager mode (shared with the waiter group). */
export default function Screen() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  return <TicketDetailScreen ticketId={String(ticketId)} mode="manager" />;
}
