import { useEffect } from 'react';
import type { QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';
import { create } from 'zustand';
import { qk } from '../api/queryKeys';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export const useConnectionStore = create<{ state: ConnectionState; lastConnectedAt: number | null }>(() => ({
  state: 'disconnected',
  lastConnectedAt: null,
}));
const setConn = (state: ConnectionState) =>
  useConnectionStore.setState(state === 'connected' ? { state, lastConnectedAt: Date.now() } : { state });

// ---------------------------------------------------------------- invalidation map
type Payload = Record<string, unknown> | undefined;

/** Event -> query keys to invalidate (matrix §9). Payloads are mostly empty, so this is coarse by design. */
export function invalidationsFor(event: string, payload: Payload): readonly (readonly unknown[])[] {
  const ticketId = typeof payload?.ticket_id === 'string' ? payload.ticket_id : undefined;
  switch (event) {
    case 'floor:update':
      return [qk.resources];
    case 'kitchen:update':
    case 'kitchen:item_update':
      return [qk.queue('KITCHEN'), qk.queueCounts];
    case 'bar:update':
    case 'bar:item_update':
      return [qk.queue('BAR'), qk.queueCounts];
    case 'ticket:updated':
    case 'ticket:item_status':
      // ticket:item_status has no ticket_id until backend ext B2 -> invalidate every cached ticket.
      return [ticketId ? qk.ticket(ticketId) : (['ticket'] as const)];
    case 'pool:timer_voided':
      return [qk.resources, ticketId ? qk.ticket(ticketId) : (['ticket'] as const)];
    case 'waiting:update':
    case 'waiting_list:update': // server name mismatch G16: handle both
      return [qk.waiting];
    case 'settings:changed':
      return [typeof payload?.key === 'string' ? qk.settings(payload.key) : qk.settings()];
    default:
      return [];
  }
}

export function handleRealtimeEvent(event: string, payload: Payload, qc: QueryClient) {
  for (const key of invalidationsFor(event, payload)) qc.invalidateQueries({ queryKey: key as unknown[] });
}

/** After (re)connect events may have been missed (not replayed): resync everything cheap. */
export function resyncAll(qc: QueryClient) {
  for (const key of [qk.resources, ['queue'], qk.waiting, ['ticket'], qk.settings(), qk.cash, qk.stock, ['tickets']] as const)
    qc.invalidateQueries({ queryKey: key as unknown as unknown[] });
}

// ---------------------------------------------------------------- feature subscriptions
type Listener = (payload: Payload) => void;
const listeners = new Map<string, Set<Listener>>();

/** Subscribe to a raw socket event (e.g. 'kitchen:item_update' for ready notifications). */
export function onRealtimeEvent(event: string, fn: Listener): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}

export function useRealtimeEvent(event: string, handler: Listener) {
  // Memoize `handler` (useCallback) in the caller to avoid re-subscribing every render.
  useEffect(() => onRealtimeEvent(event, handler), [event, handler]);
}

// ---------------------------------------------------------------- connection manager
export interface ConnectOptions {
  baseUrl: string;
  role: string;
  queryClient: QueryClient;
  /** Read at every (re)join so a refreshed JWT is used for the manager room. */
  getToken: () => string | null;
}

let socket: Socket | null = null;
let opts: ConnectOptions | null = null;
const ticketRooms = new Set<string>();
/** Extra public rooms a feature wants regardless of role (e.g. WAITER -> kitchen + bar for READY events). */
const extraRooms = new Set<string>();

/** Rooms a role subscribes to on connect (web useSocket.joinRooms). */
export function roomsForRole(role: string): { room: string; withToken?: boolean }[] {
  const rooms: { room: string; withToken?: boolean }[] = [{ room: 'floor' }];
  if (role === 'KITCHEN_STAFF' || role === 'MANAGER' || role === 'ADMIN') rooms.push({ room: 'kitchen' });
  if (role === 'BAR_STAFF' || role === 'MANAGER' || role === 'ADMIN') rooms.push({ room: 'bar' });
  if (role === 'MANAGER' || role === 'ADMIN') rooms.push({ room: 'manager', withToken: true });
  return rooms;
}

function joinAll() {
  if (!socket || !opts) return;
  for (const { room, withToken } of roomsForRole(opts.role))
    socket.emit('join', withToken ? { room, token: opts.getToken() } : { room });
  ticketRooms.forEach((id) => socket!.emit('join', { room: `ticket:${id}` }));
  extraRooms.forEach((room) => socket!.emit('join', { room }));
}

export function connectSocket(o: ConnectOptions) {
  disconnectSocket();
  opts = o;
  setConn('connecting');
  const s = io(o.baseUrl, {
    path: '/socket.io',
    transports: ['websocket', 'polling'],
    forceNew: true, // L7: own Manager per connection, so reconnect_attempt listeners cannot pile up on a cached one
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10_000,
  });
  socket = s;

  s.on('connect', () => {
    setConn('connected');
    joinAll(); // re-joins floor/kitchen/bar/manager and every open ticket room
    resyncAll(o.queryClient);
  });
  s.on('disconnect', () => setConn('reconnecting'));
  s.on('connect_error', () => setConn('reconnecting'));
  s.io.on('reconnect_attempt', () => setConn('reconnecting'));

  s.onAny((event: string, payload: Payload) => {
    handleRealtimeEvent(event, payload, o.queryClient);
    listeners.get(event)?.forEach((fn) => fn(payload));
  });
}

export function disconnectSocket() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
  }
  socket = null;
  opts = null;
  ticketRooms.clear();
  extraRooms.clear();
  setConn('disconnected');
}

/** Name of the active Socket.IO transport ('websocket' | 'polling'), null when not connected. */
export function socketTransport(): string | null {
  return socket?.connected ? (socket.io.engine?.transport?.name ?? null) : null;
}

export function joinTicket(id: string) {
  ticketRooms.add(id);
  if (socket?.connected) socket.emit('join', { room: `ticket:${id}` });
}

export function leaveTicket(id: string) {
  ticketRooms.delete(id);
  if (socket?.connected) socket.emit('leave', { room: `ticket:${id}` });
}

/** Join a public room (floor/kitchen/bar...); re-joined on every reconnect. Pair with `leaveRoom`. */
export function joinRoom(room: string) {
  extraRooms.add(room);
  if (socket?.connected) socket.emit('join', { room });
}

export function leaveRoom(room: string) {
  extraRooms.delete(room);
  if (socket?.connected && !(opts && roomsForRole(opts.role).some((r) => r.room === room))) socket.emit('leave', { room });
}

/** Hook for ticket screens: joins on mount, leaves on unmount. */
export function useTicketRoom(id: string | undefined) {
  useEffect(() => {
    if (!id) return;
    joinTicket(id);
    return () => leaveTicket(id);
  }, [id]);
}
