import { useLocalSearchParams } from 'expo-router';
import { TicketDetailScreen } from '../../../../src/features/waiter/ticket/TicketDetailScreen';

export default function Screen() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  return <TicketDetailScreen ticketId={ticketId} mode="waiter" />;
}
