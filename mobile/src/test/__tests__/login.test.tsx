import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import { ApiError } from '../../api/client';
import { mockServerConfig, renderWithProviders } from '../utils';
import { useAuthStore } from '../../state/authStore';
import LoginScreen from '../../../app/login';

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: mockReplace, push: jest.fn() }) }));

beforeEach(() => {
  mockReplace.mockClear();
  mockServerConfig();
});

const submit = async (u: string, p: string) => {
  await fireEvent.changeText(screen.getByTestId('login-username'), u);
  await fireEvent.changeText(screen.getByTestId('login-password'), p);
  await fireEvent.press(screen.getByTestId('login-submit'));
};

it('shows Spanish copy and rejects empty fields', async () => {
  await renderWithProviders(<LoginScreen />);
  expect(screen.getByText('Hola, inicia sesión')).toBeTruthy();
  await fireEvent.press(screen.getByTestId('login-submit'));
  expect(screen.getByTestId('login-error').props.children).toBe('Escribe usuario y contraseña.');
});

it.each([
  [new ApiError({ status: 401, code: 'INVALID_CREDENTIALS', message: '' }), 'Usuario o contraseña incorrectos. Revísalos e inténtalo otra vez.'],
  [new ApiError({ status: 429, code: 'HTTP_429', message: '' }), 'Demasiados intentos. Espera un minuto e inténtalo de nuevo.'],
  [new ApiError({ code: 'NETWORK_ERROR', message: '', isNetwork: true }), 'Sin conexión con el servidor. Revisa el Wi-Fi.'],
])('shows the right error (%#)', async (err, text) => {
  useAuthStore.setState({ login: jest.fn().mockRejectedValue(err) });
  await renderWithProviders(<LoginScreen />);
  await submit('ana', 'x');
  await waitFor(() => expect(screen.getByTestId('login-error').props.children).toBe(text));
  expect(mockReplace).not.toHaveBeenCalled();
});

it('routes to the role home on success', async () => {
  useAuthStore.setState({ login: jest.fn().mockResolvedValue({ id: '1', username: 'k', name: 'K', role: 'KITCHEN_STAFF' }) });
  await renderWithProviders(<LoginScreen />);
  await submit('k', 'x');
  await waitFor(() => expect(mockReplace).toHaveBeenCalledWith('/queue'));
});
