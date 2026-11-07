import { fireEvent, screen, userEvent } from '@testing-library/react-native';
import { ConfirmDialog } from '../ConfirmDialog';
import { renderWithProviders } from '../../test/utils';

const base = { title: '¿Cerrar sesión?', message: 'Tendrás que entrar de nuevo.', confirmLabel: 'Cerrar sesión', cancelLabel: 'Cancelar' };

describe('ConfirmDialog', () => {
  it('renders title, message and both actions', async () => {
    await renderWithProviders(<ConfirmDialog visible {...base} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.getByText('¿Cerrar sesión?')).toBeTruthy();
    expect(screen.getByText('Tendrás que entrar de nuevo.')).toBeTruthy();
    expect(screen.getByTestId('confirm-dialog-confirm')).toBeTruthy();
    expect(screen.getByTestId('confirm-dialog-cancel')).toBeTruthy();
  });

  it('renders nothing when not visible', async () => {
    await renderWithProviders(<ConfirmDialog visible={false} {...base} onConfirm={jest.fn()} onCancel={jest.fn()} />);
    expect(screen.queryByText('¿Cerrar sesión?')).toBeNull();
  });

  it('confirm and cancel call their handlers', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await renderWithProviders(<ConfirmDialog visible {...base} onConfirm={onConfirm} onCancel={onCancel} />);
    await fireEvent.press(screen.getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    await fireEvent.press(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('outside tap cancels', async () => {
    const onCancel = jest.fn();
    await renderWithProviders(<ConfirmDialog visible {...base} onConfirm={jest.fn()} onCancel={onCancel} />);
    await fireEvent.press(screen.getByTestId('confirm-dialog-scrim'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('while loading: no cancel by scrim, confirm presses are ignored', async () => {
    const onConfirm = jest.fn();
    const onCancel = jest.fn();
    await renderWithProviders(<ConfirmDialog visible loading destructive {...base} onConfirm={onConfirm} onCancel={onCancel} />);
    const user = userEvent.setup();
    await user.press(screen.getByTestId('confirm-dialog-scrim'));
    await user.press(screen.getByTestId('confirm-dialog-cancel'));
    await user.press(screen.getByTestId('confirm-dialog-confirm'));
    expect(onCancel).not.toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
