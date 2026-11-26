import '../../../i18n';
import { fireEvent, render, screen } from '@testing-library/react-native';
import type { ReactNode } from 'react';
import ManagerTabsLayout from '../../../../app/(manager)/(tabs)/_layout';
import { useAuthStore } from '../../../state/authStore';
import { MoreScreen } from '../MoreScreen';

const mockPush = jest.fn();
const mockScreens: { name: string; options: Record<string, unknown> }[] = [];
jest.mock('expo-router', () => {
  const Tabs = ({ children }: { children: ReactNode }) => children;
  // eslint-disable-next-line react/display-name
  Tabs.Screen = (p: { name: string; options: Record<string, unknown> }) => {
    mockScreens.push(p);
    return null;
  };
  return { useRouter: () => ({ push: mockPush }), Tabs };
});
jest.mock('../printFailures', () => ({ usePrintFailureListener: jest.fn() }));

const login = (role: string) => useAuthStore.setState({ user: { id: 'u', username: 'u', name: 'U', role } as never });

beforeEach(() => {
  mockPush.mockClear();
  mockScreens.length = 0;
});
afterEach(() => useAuthStore.setState({ user: null }));

describe('Mas navigation', () => {
  it('ADMIN: Sistema pushes /system and every entry resolves to its route', async () => {
    login('ADMIN');
    await render(<MoreScreen />);
    const targets: Record<string, string> = { kds: '/queue', waiting: '/waiting', floor: '/floor-view', system: '/system', profile: '/profile' };
    for (const [k, href] of Object.entries(targets)) {
      await fireEvent.press(screen.getByTestId(`more-${k}`));
      expect(mockPush).toHaveBeenLastCalledWith(href);
    }
  });

  it('MANAGER does not get Sistema or Piso in Mas; Cocina/Barra is the /kds tab route', async () => {
    login('MANAGER');
    await render(<MoreScreen />);
    expect(screen.queryByTestId('more-system')).toBeNull();
    await fireEvent.press(screen.getByTestId('more-kds'));
    expect(mockPush).toHaveBeenLastCalledWith('/kds');
  });

  // expo-router 58 turns `href: null` into a hidden tab, and navigating to a hidden tab bounces to Resumen.
  it.each(['ADMIN', 'MANAGER'])('%s tabs layout: Mas destinations are never `href: null` (hidden) tabs', async (role) => {
    login(role);
    await render(<ManagerTabsLayout />);
    const byName = Object.fromEntries(mockScreens.map((s) => [s.name, s.options]));
    for (const name of ['kds', 'system', 'profile', 'floor-view', 'reportes']) {
      expect(byName[name]).toBeDefined();
      expect(byName[name]).not.toHaveProperty('href', null);
    }
  });
});
