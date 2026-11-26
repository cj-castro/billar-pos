import { QueryClient } from '@tanstack/react-query';
import { io } from 'socket.io-client';
import { setServerInfo } from '../../config/serverInfo';
import { connectSocket, disconnectSocket } from '../socket';

jest.mock('socket.io-client', () => ({ io: jest.fn() }));
jest.mock('../../api/client', () => ({ refreshOnce: jest.fn() }));

function fakeSocket() {
  const handlers: Record<string, () => void> = {};
  return {
    handlers,
    emit: jest.fn(),
    on: jest.fn((e: string, fn: () => void) => void (handlers[e] = fn)),
    onAny: jest.fn(),
    removeAllListeners: jest.fn(),
    disconnect: jest.fn(),
    io: { on: jest.fn() },
  };
}

function connect(token: string | null) {
  const sock = fakeSocket();
  (io as unknown as jest.Mock).mockReturnValue(sock);
  connectSocket({ baseUrl: 'http://x', role: 'MANAGER', queryClient: new QueryClient(), getToken: () => token });
  const auth = (io as unknown as jest.Mock).mock.calls.at(-1)![1].auth as (cb: (d: object) => void) => void;
  sock.handlers.connect();
  return { sock, auth };
}

afterEach(() => disconnectSocket());

describe('socket handshake auth (SEC-05)', () => {
  it('passes the CURRENT token in auth on every (re)connect attempt', () => {
    let token = 'old';
    const sock = fakeSocket();
    (io as unknown as jest.Mock).mockReturnValue(sock);
    connectSocket({ baseUrl: 'http://x', role: 'WAITER', queryClient: new QueryClient(), getToken: () => token });
    const auth = (io as unknown as jest.Mock).mock.calls.at(-1)![1].auth as (cb: (d: object) => void) => void;
    const seen: object[] = [];
    auth((d) => seen.push(d));
    token = 'refreshed';
    auth((d) => seen.push(d));
    expect(seen).toEqual([{ token: 'old' }, { token: 'refreshed' }]);
  });

  it('server without socket_handshake_auth: manager join still carries the legacy token', () => {
    setServerInfo({ status: 'ok' });
    const { sock } = connect('jwt');
    expect(sock.emit).toHaveBeenCalledWith('join', { room: 'manager', token: 'jwt' });
  });

  it('server with socket_handshake_auth: join carries no token', () => {
    setServerInfo({ status: 'ok', features: ['socket_handshake_auth'] });
    const { sock } = connect('jwt');
    expect(sock.emit).toHaveBeenCalledWith('join', { room: 'manager' });
    expect(sock.emit).not.toHaveBeenCalledWith('join', expect.objectContaining({ token: expect.anything() }));
  });
});

describe('connect_error token refresh (M12)', () => {
  const setup = () => {
    const sock = { ...fakeSocket(), connected: false, connect: jest.fn() };
    sock.disconnect = jest.fn(() => sock) as never;
    (io as unknown as jest.Mock).mockReturnValue(sock);
    return sock;
  };
  const flush = () => new Promise((r) => setImmediate(r));

  it('refreshes once and reconnects; a second error before connecting does not loop', async () => {
    const refreshOnce = jest.requireMock('../../api/client').refreshOnce as jest.Mock;
    refreshOnce.mockResolvedValue('new');
    const sock = setup();
    connectSocket({ baseUrl: 'http://x', role: 'WAITER', queryClient: new QueryClient(), getToken: () => 'jwt' });
    const onErr = (sock.handlers as Record<string, () => void>).connect_error;
    onErr();
    await flush();
    expect(refreshOnce).toHaveBeenCalledTimes(1);
    expect(sock.connect).toHaveBeenCalledTimes(1);
    onErr();
    await flush();
    expect(refreshOnce).toHaveBeenCalledTimes(1);
    sock.handlers.connect(); // success re-arms
    onErr();
    await flush();
    expect(refreshOnce).toHaveBeenCalledTimes(2);
  });

  it('does nothing without a token', async () => {
    const refreshOnce = jest.requireMock('../../api/client').refreshOnce as jest.Mock;
    refreshOnce.mockClear();
    const sock = setup();
    connectSocket({ baseUrl: 'http://x', role: 'WAITER', queryClient: new QueryClient(), getToken: () => null });
    sock.handlers.connect_error();
    await flush();
    expect(refreshOnce).not.toHaveBeenCalled();
  });
});
