import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';

/** router.canGoBack() read after mount: during the first render the pushed route is not in the router state yet. */
export function useCanGoBack(): boolean {
  const router = useRouter();
  const [can, setCan] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- reading router state after mount is the point
  useEffect(() => setCan(router.canGoBack()), [router]);
  return can;
}
