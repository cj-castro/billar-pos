import { canAccess, routeForRole, type RouteGroup } from '../roleRouting';
import { loginErrorKey } from '../loginErrors';
import { ApiError } from '../../api/client';

describe('routeForRole', () => {
  it('maps roles to groups and stations', () => {
    expect(routeForRole('WAITER')).toMatchObject({ group: '(waiter)', href: '/floor' });
    expect(routeForRole('KITCHEN_STAFF')).toMatchObject({ group: '(kitchen)', station: 'KITCHEN' });
    expect(routeForRole('BAR_STAFF')).toMatchObject({ group: '(kitchen)', station: 'BAR' });
    expect(routeForRole('MANAGER')).toMatchObject({ group: '(manager)' });
    expect(routeForRole('ADMIN')).toMatchObject({ group: '(manager)', href: '/overview' });
  });

  it.each(['CASHIER', '', null, undefined, 'waiter'])('unknown role %p -> /denied', (r) => {
    expect(routeForRole(r as string).href).toBe('/denied');
  });
});

describe('canAccess', () => {
  const groups: RouteGroup[] = ['(waiter)', '(kitchen)', '(manager)'];
  const allowed = (role: string) => groups.filter((g) => canAccess(role, g));

  it('enforces the matrix', () => {
    expect(allowed('WAITER')).toEqual(['(waiter)']);
    expect(allowed('KITCHEN_STAFF')).toEqual(['(kitchen)']);
    expect(allowed('BAR_STAFF')).toEqual(['(kitchen)']);
    expect(allowed('MANAGER')).toEqual(['(waiter)', '(kitchen)', '(manager)']);
    expect(allowed('ADMIN')).toEqual(groups);
  });

  it('denies unknown / missing roles everywhere', () => {
    expect(allowed('HACKER')).toEqual([]);
    expect(allowed(undefined as unknown as string)).toEqual([]);
  });
});

describe('loginErrorKey', () => {
  it('maps failures to copy keys', () => {
    expect(loginErrorKey(new ApiError({ status: 401, code: 'INVALID_CREDENTIALS', message: '' }))).toBe('login.errInvalid');
    expect(loginErrorKey(new ApiError({ status: 429, code: 'HTTP_429', message: '' }))).toBe('login.errRateLimit');
    expect(loginErrorKey(new ApiError({ code: 'NETWORK_ERROR', message: '', isNetwork: true }))).toBe('login.errNetwork');
    expect(loginErrorKey(new ApiError({ code: 'TIMEOUT', message: '', isTimeout: true }))).toBe('login.errTimeout');
    expect(loginErrorKey(new ApiError({ status: 500, code: 'HTTP_500', message: '' }))).toBe('login.errServer');
    expect(loginErrorKey(new Error('x'))).toBe('login.errServer');
  });
});
