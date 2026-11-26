import { useLocalSearchParams } from 'expo-router';
import { MenuScreen } from '../../../../src/features/waiter/menu/MenuScreen';

export default function Screen() {
  const { ticketId } = useLocalSearchParams<{ ticketId: string }>();
  return <MenuScreen ticketId={ticketId} />;
}
