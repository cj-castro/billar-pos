import { render, screen } from '@testing-library/react-native';
import { Text } from 'react-native';
import { canAccess, routeForRole, type RouteGroup } from '../roleRouting';
import { GroupGuard } from '../../components/GroupGuard';
import { useAuthStore } from '../../state/authStore';

jest.mock('expo-router', () => {
  const { Text: T } = jest.requireActual('react-native');
  return {
    Redirect: ({ href }: { href: string }) => <T testID="redirect">{href}</T>,
    Stack: () => <T testID="stack">stack</T>,
  };
});

const GROUPS: RouteGroup[] = ['(waiter)', '(kitchen)', '(manager)'];

/** Role x group access matrix (D9 + R1). true = may enter. */
const MATRIX: Record<string, Record<RouteGroup, boolean>> = {
  WAITER: { '(waiter)': true, '(kitchen)': false, '(manager)': false },
  KITCHEN_STAFF: { '(waiter)': false, '(kitchen)': true, '(manager)': false },
  BAR_STAFF: { '(waiter)': false, '(kitchen)': true, '(manager)': false },
  MANAGER: { '(waiter)': true, '(kitchen)': true, '(manager)': true },
  ADMIN: { '(waiter)': true, '(kitchen)': true, '(manager)': true },
  CASHIER: { '(waiter)': false, '(kitchen)': false, '(manager)': false }, // unknown role
};

describe('canAccess: role x group matrix', () => {
  for (const [role, row] of Object.entries(MATRIX)) {
    for (const g of GROUPS) {
      it(`${role} ${row[g] ? 'may' : 'may NOT'} enter ${g}`, () => expect(canAccess(role, g)).toBe(row[g]));
    }
  }
  it('null / undefined role enters nothing', () => {
    for (const g of GROUPS) {
      expect(canAccess(null, g)).toBe(false);
      expect(canAccess(undefined, g)).toBe(false);
    }
  });
});

describe('home route per role', () => {
  it('kitchen and bar staff land on the KDS with their station; waiter and manager elsewhere', () => {
    expect(routeForRole('KITCHEN_STAFF')).toEqual({ group: '(kitchen)', href: '/queue', station: 'KITCHEN' });
    expect(routeForRole('BAR_STAFF')).toEqual({ group: '(kitchen)', href: '/queue', station: 'BAR' });
    expect(routeForRole('WAITER').group).toBe('(waiter)');
    expect(routeForRole('MANAGER').group).toBe('(manager)');
    expect(routeForRole('ADMIN').group).toBe('(manager)');
    expect(routeForRole('HACKER').href).toBe('/denied');
  });
});

describe('GroupGuard: deep-link attempts', () => {
  const asUser = (role: string | null) =>
    useAuthStore.setState({ user: role ? { id: 'u', username: 'u', name: 'U', role } : null, accessToken: null, refreshToken: null });

  afterEach(() => asUser(null));

  for (const [role, row] of Object.entries(MATRIX)) {
    for (const g of GROUPS) {
      it(`${role} deep-linking into ${g} -> ${row[g] ? 'allowed' : '/denied'}`, async () => {
        asUser(role);
        await render(<GroupGuard group={g} />);
        if (row[g]) {
          expect(screen.getByTestId('stack')).toBeTruthy();
          expect(screen.queryByTestId('redirect')).toBeNull();
        } else {
          expect(screen.getByTestId('redirect').props.children).toBe('/denied');
          expect(screen.queryByTestId('stack')).toBeNull();
        }
      });
    }
  }

  it('signed-out deep link goes to /login', async () => {
    asUser(null);
    await render(<GroupGuard group="(manager)" />);
    expect(screen.getByTestId('redirect').props.children).toBe('/login');
  });

  it('never renders protected children for a denied role', async () => {
    asUser('WAITER');
    await render(
      <GroupGuard group="(manager)">
        <Text testID="secret">manager only</Text>
      </GroupGuard>,
    );
    expect(screen.queryByTestId('secret')).toBeNull();
  });
});
