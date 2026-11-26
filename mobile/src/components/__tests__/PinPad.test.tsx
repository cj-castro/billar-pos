import { act, fireEvent, screen, userEvent } from '@testing-library/react-native';
import { PinPad } from '../PinPad';
import { renderWithProviders } from '../../test/utils';

const tap = async (...digits: string[]) => {
  for (const d of digits) await fireEvent.press(screen.getByTestId(`pin-key-${d}`));
};
const dotsLabel = () => screen.getByTestId('pin-dots').props.accessibilityLabel as string;

describe('PinPad', () => {
  it('auto-submits at the configured length and clears the digits', async () => {
    const onSubmit = jest.fn();
    await renderWithProviders(<PinPad length={4} onSubmit={onSubmit} />);
    await tap('1', '2', '3');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dotsLabel()).toBe('3 de 4 dígitos');
    await tap('4');
    expect(onSubmit).toHaveBeenCalledWith('1234');
    expect(dotsLabel()).toBe('0 de 4 dígitos'); // never retained
  });

  it('masks input: digits never appear in the accessibility tree', async () => {
    await renderWithProviders(<PinPad onSubmit={jest.fn()} />);
    await tap('7', '7');
    expect(dotsLabel()).not.toMatch(/7/);
    expect(screen.queryByText('77')).toBeNull();
  });

  it('backspace removes the last digit', async () => {
    await renderWithProviders(<PinPad onSubmit={jest.fn()} />);
    await tap('1', '2');
    await fireEvent.press(screen.getByTestId('pin-backspace'));
    expect(dotsLabel()).toBe('1 de 4 dígitos');
  });

  it('clamps length to 4..6 and supports 6 digits', async () => {
    const onSubmit = jest.fn();
    await renderWithProviders(<PinPad length={9} onSubmit={onSubmit} />);
    await tap('1', '2', '3', '4', '5');
    expect(onSubmit).not.toHaveBeenCalled();
    await tap('6');
    expect(onSubmit).toHaveBeenCalledWith('123456');
  });

  it('Confirmar needs at least 4 digits', async () => {
    const onSubmit = jest.fn();
    await renderWithProviders(<PinPad length={6} onSubmit={onSubmit} />);
    await tap('1', '2', '3');
    await userEvent.setup().press(screen.getByTestId('pin-confirm'));
    expect(onSubmit).not.toHaveBeenCalled();
    await tap('4');
    await userEvent.setup().press(screen.getByTestId('pin-confirm'));
    expect(onSubmit).toHaveBeenCalledWith('1234');
  });

  it('ignores keys while loading', async () => {
    const onSubmit = jest.fn();
    await renderWithProviders(<PinPad loading onSubmit={onSubmit} />);
    await tap('1', '2', '3', '4');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(dotsLabel()).toBe('0 de 4 dígitos');
  });

  it('shows the error message', async () => {
    await renderWithProviders(<PinPad error="PIN incorrecto. Intenta de nuevo." onSubmit={jest.fn()} />);
    expect(screen.getByTestId('pin-message').props.children).toBe('PIN incorrecto. Intenta de nuevo.');
  });

  it('locks the keypad with a countdown after a 429', async () => {
    const onSubmit = jest.fn();
    await renderWithProviders(<PinPad lockedUntil={Date.now() + 30_000} onSubmit={onSubmit} />);
    expect([screen.getByTestId('pin-message').props.children].flat().join('')).toMatch(/Demasiados intentos.*\(\d+ s\)/);
    await tap('1', '2', '3', '4');
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => {});
  });

  it('cancel calls onCancel', async () => {
    const onCancel = jest.fn();
    await renderWithProviders(<PinPad onSubmit={jest.fn()} onCancel={onCancel} />);
    await fireEvent.press(screen.getByTestId('pin-cancel'));
    expect(onCancel).toHaveBeenCalled();
  });
});
