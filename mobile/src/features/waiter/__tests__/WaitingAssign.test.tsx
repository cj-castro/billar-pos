import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { makeRouter, mockApi, online, renderScreen, resource, ticket } from '../testing/testkit';
import { WaitingScreen } from '../waiting/WaitingScreen';

const mockRouter = makeRouter();
jest.mock('expo-router', () => ({ useRouter: () => mockRouter }));

const entry = { id: 'w1', party_name: 'Ruiz', party_size: 4, status: 'WAITING', position: 1, created_at: '2026-11-05T20:00:00+00:00' };

beforeEach(() => {
  jest.clearAllMocks();
  online(true);
});

describe('waiting-list assign', () => {
  it('pool table asks for confirmation (billing starts) before assigning; a regular table does not', async () => {
    const m = mockApi({
      'GET /waiting-list': { data: [entry] },
      'GET /resources': { data: [resource({ id: 'bt1', code: 'BT1', type: 'POOL_TABLE' }), resource({ id: 't2', code: 'T2' })] },
      'POST /waiting-list/w1/assign': { data: { entry, ticket: ticket({ id: 'tk9' }) } },
    });
    await renderScreen(<WaitingScreen />);
    await fireEvent.press(await screen.findByTestId('waiting-assign-w1'));
    await fireEvent.press(await screen.findByTestId('assign-table-BT1'));
    expect(screen.getByText('Se iniciará el tiempo de billar')).toBeTruthy();
    expect(m.of('POST', /assign/)).toHaveLength(0);
    await fireEvent.press(screen.getByTestId('waiting-pool-dialog-confirm'));
    await waitFor(() => expect(m.of('POST', /assign/)).toHaveLength(1));
    expect(m.of('POST', /assign/)[0].data).toEqual({ resource_id: 'bt1' });
  });

  it('regular table assigns directly', async () => {
    const m = mockApi({
      'GET /waiting-list': { data: [entry] },
      'GET /resources': { data: [resource({ id: 't2', code: 'T2' })] },
      'POST /waiting-list/w1/assign': { data: { entry, ticket: ticket({ id: 'tk9' }) } },
    });
    await renderScreen(<WaitingScreen />);
    await fireEvent.press(await screen.findByTestId('waiting-assign-w1'));
    await fireEvent.press(await screen.findByTestId('assign-table-T2'));
    await waitFor(() => expect(m.of('POST', /assign/)).toHaveLength(1));
  });
});
