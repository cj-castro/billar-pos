import { fireEvent, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { ScreenHeader } from '../ScreenHeader';
import { renderWithProviders } from '../../test/utils';

describe('ScreenHeader', () => {
  it('renders a working back button when onBack is given', async () => {
    const onBack = jest.fn();
    await renderWithProviders(<ScreenHeader title="Mesa T05" onBack={onBack} />);
    await fireEvent.press(screen.getByTestId('header-back'));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('has no back button on roots, and the title ellipsizes next to a leading logo + right slot', async () => {
    await renderWithProviders(<ScreenHeader title="Cocina" leading={<Text>logo</Text>} right={<Text>pill</Text>} />);
    expect(screen.queryByTestId('header-back')).toBeNull();
    expect(screen.getByText('Cocina').props.numberOfLines).toBe(1);
  });
});
