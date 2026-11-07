import { useLocalSearchParams } from 'expo-router';
import { OpenTableScreen } from '../../../src/features/waiter/openTable/OpenTableScreen';

export default function Screen() {
  const { resourceId } = useLocalSearchParams<{ resourceId: string }>();
  return <OpenTableScreen resourceId={resourceId} />;
}
