import { act, fireEvent, screen, userEvent } from '@testing-library/react-native';
import { Text } from 'react-native';
import { AppButton } from '../AppButton';
import { connectionLevel } from '../connection';
import { formatAge } from '../KdsAgeBadge';
import { ModifierGroup } from '../ModifierGroup';
import { QuantityStepper } from '../QuantityStepper';
import { StatusChip } from '../StatusChip';
import { ToastProvider, useToast } from '../Toast';
import { renderWithProviders } from '../../test/utils';

describe('AppButton', () => {
  it('fires onPress; ignores presses when loading but keeps the a11y state', async () => {
    const onPress = jest.fn();
    await renderWithProviders(<AppButton label="Enviar" onPress={onPress} testID="b" />);
    await fireEvent.press(screen.getByTestId('b'));
    expect(onPress).toHaveBeenCalledTimes(1);
    await screen.unmount();

    const p2 = jest.fn();
    await renderWithProviders(<AppButton label="Enviar" onPress={p2} loading testID="b" />);
    await userEvent.setup().press(screen.getByTestId('b')); // userEvent: honours the host handler, not composite props
    expect(p2).not.toHaveBeenCalled();
    expect(screen.getByTestId('b').props.accessibilityState).toMatchObject({ disabled: true, busy: true });
  });
});

describe('StatusChip', () => {
  it('shows the word, not just a colour', async () => {
    await renderWithProviders(<StatusChip kind="item" status="IN_PROGRESS" />);
    expect(screen.getByText('En preparación')).toBeTruthy();
    expect(screen.getByLabelText('En preparación')).toBeTruthy();
  });
});

describe('QuantityStepper', () => {
  it('steps within bounds', async () => {
    const onChange = jest.fn();
    await renderWithProviders(<QuantityStepper value={1} min={1} max={2} onChange={onChange} testID="q" />);
    await fireEvent.press(screen.getByTestId('q-dec')); // at min: ignored
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('q-inc'));
    expect(onChange).toHaveBeenCalledWith(2);
  });
});

describe('ModifierGroup', () => {
  it('multi-select at max disables unselected options', async () => {
    const onChange = jest.fn();
    const options = [
      { id: 'a', name: 'BBQ', priceDeltaCents: 0 },
      { id: 'b', name: 'Búfalo', priceDeltaCents: 1000 },
      { id: 'c', name: 'Ranch', priceDeltaCents: 0 },
    ];
    await renderWithProviders(
      <ModifierGroup title="Salsa" mandatory min={1} max={2} allowMultiple options={options} selectedIds={['a', 'b']} onChange={onChange} testID="g" />,
    );
    expect(screen.getByText('Obligatorio · elige 1 a 2')).toBeTruthy();
    expect(screen.getByText(/2 de 2 elegidas/)).toBeTruthy();
    await fireEvent.press(screen.getByTestId('g-c')); // blocked: already at max
    expect(onChange).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId('g-a')); // deselect
    expect(onChange).toHaveBeenCalledWith(['b']);
  });
});

describe('Toast', () => {
  it('shows a toast with an action and the action fires', async () => {
    const onPress = jest.fn();
    const Trigger = () => {
      const toast = useToast();
      return <Text onPress={() => toast.show({ tone: 'success', title: '2 productos listos', action: { label: 'Ver', onPress } })}>go</Text>;
    };
    await renderWithProviders(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await fireEvent.press(screen.getByText('go'));
    expect(screen.getByText('2 productos listos')).toBeTruthy();
    await fireEvent.press(screen.getByTestId('toast-action'));
    expect(onPress).toHaveBeenCalled();
    await act(async () => {});
  });
});

describe('connection helpers', () => {
  it('connectionLevel combines socket + OS reachability', () => {
    expect(connectionLevel('connected', true)).toBe('online');
    expect(connectionLevel('connected', false)).toBe('offline');
    expect(connectionLevel('reconnecting', true)).toBe('reconnecting');
    expect(connectionLevel('connecting', true)).toBe('reconnecting');
    expect(connectionLevel('disconnected', true)).toBe('offline');
  });
  it('formatAge m:ss / h:mm', () => {
    expect(formatAge(0)).toBe('0:00');
    expect(formatAge(125)).toBe('2:05');
    expect(formatAge(3600 + 7 * 60)).toBe('1:07');
    expect(formatAge(-5)).toBe('0:00');
  });
});
