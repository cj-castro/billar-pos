import { useQuery } from '@tanstack/react-query';
import { listWaiting } from '../../../api/endpoints/waitingList';
import { qk2 } from '../../../api/queryKeys';
import { visibleEntries } from './waitingModel';

/** WAITING + SEATED entries. waiting:update / waiting_list:update refresh it (invalidation map in realtime/socket.ts). */
export function useWaitingList() {
  const q = useQuery({ queryKey: qk2.waitingList, queryFn: listWaiting, staleTime: 15_000 });
  return { ...q, entries: visibleEntries(q.data ?? []) };
}
