import { useLocalSearchParams } from 'expo-router';
import { ConfiguratorScreen } from '../../../../../src/features/waiter/configure/ConfiguratorScreen';

export default function Screen() {
  const { ticketId, itemId } = useLocalSearchParams<{ ticketId: string; itemId: string }>();
  return <ConfiguratorScreen ticketId={ticketId} itemId={itemId} />;
}
