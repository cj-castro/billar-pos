import { QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import { __setServerUrlForTests } from '../../../config/serverConfig';
import { useAuthStore } from '../../../state/authStore';
import { mockServerConfig } from '../../../test/utils';
import { useDraftStore } from '../draft/draftStore';
import { useSendDraft } from '../draft/useSendDraft';
import { line, mockApi, networkError, online, setOnline, testQueryClient, ticket } from '../testing/testkit';

const add = (name: string) => useDraftStore.getState().addLine('t1', { menuItemId: `id-${name}`, name, unitPriceCents: 10000, quantity: 1, modifiers: [], notes: '' });
const lines = () => useDraftStore.getState().byTicket.t1 ?? [];
const user = (id: string) => ({ id, username: id, name: id, role: 'WAITER' }) as never;
const POSTS = /\/tickets\/t1\/items$/;

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
  mockServerConfig();
  useDraftStore.setState({ byTicket: {}, b1Confirmed: {}, ownerId: null });
  useAuthStore.setState({ user: user('A'), accessToken: 'ta', refreshToken: 'ra' });
});

/** First POST is held until `release()`; later POSTs would resolve at once. */
function heldApi() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let n = 0;
  const m = mockApi({
    'GET /tickets/t1': () => ({ data: ticket({ version: 3 }) }),
    'POST /tickets/t1/items': async () => {
      if (n++ === 0) await gate;
      return { status: 201, data: { ...line({}), ticket_version: 4 + n } };
    },
  });
  return { m, release };
}

async function startSend() {
  const qc = testQueryClient();
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
  const { result } = await renderHook(() => useSendDraft('t1'), { wrapper });
  await act(async () => result.current.send());
  return result;
}

describe('send run binding (session / server)', () => {
  it('logout + login as another user while line 1 is in flight: no further POST, no store writes', async () => {
    const { m, release } = heldApi();
    add('Alitas');
    add('Nachos');
    await startSend();
    await waitFor(() => expect(m.of('POST', POSTS)).toHaveLength(1));

    await act(async () => {
      useAuthStore.setState({ user: null, accessToken: null, refreshToken: null });
      useDraftStore.getState().clearAll(); // what logout does
      useAuthStore.setState({ user: user('B'), accessToken: 'tb', refreshToken: 'rb' });
      useDraftStore.getState().claimDrafts('B');
    });
    const before = JSON.stringify(useDraftStore.getState().byTicket);
    await act(async () => release());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(m.of('POST', POSTS)).toHaveLength(1);
    expect(JSON.stringify(useDraftStore.getState().byTicket)).toBe(before);
    expect(lines()).toHaveLength(0);
  });

  it('server switch mid-run: no further POST, drafts untouched', async () => {
    const { m, release } = heldApi();
    add('Alitas');
    add('Nachos');
    await startSend();
    await waitFor(() => expect(m.of('POST', POSTS)).toHaveLength(1));
    const before = JSON.stringify(lines());
    await act(async () => __setServerUrlForTests('http://10.0.0.9:8080'));
    await act(async () => release());
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(m.of('POST', POSTS)).toHaveLength(1);
    expect(JSON.stringify(lines())).toBe(before); // line 1 stays SENDING-state as it was: no late write
  });

  it('version read offline fails promptly: no POST, lines retryable; reconnecting does not resume', async () => {
    const m = mockApi({
      'GET /tickets/t1': networkError(),
      'POST /tickets/t1/items': { status: 201, data: { ...line({}), ticket_version: 4 } },
    });
    const a = add('Alitas');
    const result = await startSend();
    await waitFor(() => expect(lines()[0]?.error).toBe('NETWORK'));
    expect(m.of('POST', POSTS)).toHaveLength(0);
    expect(lines()[0]).toMatchObject({ key: a.key, state: 'FAILED' });
    expect(lines()[0].firstAttemptVersion).toBeUndefined();
    expect(result.current.result?.stopped).toBe('network');

    online(false);
    await setOnline(true);
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(m.of('POST', POSTS)).toHaveLength(0);
    expect(m.of('GET', /\/tickets\/t1$/)).toHaveLength(1); // no retry of the read either
  });
});
