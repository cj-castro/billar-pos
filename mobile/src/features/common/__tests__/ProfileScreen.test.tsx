import { fireEvent, screen, userEvent, waitFor } from '@testing-library/react-native';
import { useAuthStore } from '../../../state/authStore';
import { mockServerConfig, renderWithProviders } from '../../../test/utils';
import { ProfileScreen } from '../ProfileScreen';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn(), back: jest.fn() }) }));

beforeEach(() => {
  mockReplace.mockClear();
  mockServerConfig();
  useAuthStore.setState({ user: { id: '1', username: 'waiter1', name: 'Sofía', role: 'WAITER' } });
});

it('shows user, role and server', async () => {
  await renderWithProviders(<ProfileScreen />);
  expect(screen.getByText('Sofía')).toBeTruthy();
  expect(screen.getByText('Mesero')).toBeTruthy();
  expect(screen.getByText('http://192.168.1.22:8080')).toBeTruthy();
});

it('logout asks for confirmation first, and cancel keeps the session', async () => {
  const logout = jest.fn().mockResolvedValue(undefined);
  useAuthStore.setState({ logout });
  await renderWithProviders(<ProfileScreen />);
  await fireEvent.press(screen.getByTestId('logout'));
  expect(screen.getByText('¿Cerrar sesión?')).toBeTruthy();
  expect(logout).not.toHaveBeenCalled();
  await fireEvent.press(screen.getByTestId('confirm-dialog-cancel'));
  expect(logout).not.toHaveBeenCalled();
});

it('confirming logs out and goes to /login', async () => {
  const logout = jest.fn().mockResolvedValue(undefined);
  useAuthStore.setState({ logout });
  await renderWithProviders(<ProfileScreen />);
  await userEvent.setup().press(screen.getByTestId('logout'));
  await userEvent.setup().press(screen.getByTestId('confirm-dialog-confirm'));
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/login'));
  expect(logout).toHaveBeenCalledTimes(1);
});

it('language toggle switches copy to English', async () => {
  await renderWithProviders(<ProfileScreen />);
  await fireEvent.press(screen.getByTestId('lang-toggle-en'));
  await waitFor(() => expect(screen.getByText('Waiter')).toBeTruthy());
  await fireEvent.press(screen.getByTestId('lang-toggle-es'));
  await waitFor(() => expect(screen.getByText('Mesero')).toBeTruthy());
});
