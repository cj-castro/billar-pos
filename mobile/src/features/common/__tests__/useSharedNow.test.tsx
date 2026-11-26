import { act, renderHook } from '@testing-library/react-native';
import { useSharedNow } from '../useSharedNow';

describe('useSharedNow', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('disabled = frozen at a captured timestamp even while others tick', async () => {
    const live = await renderHook(() => useSharedNow(true, true));
    const frozen = await renderHook(() => useSharedNow(false, true));
    const at = frozen.result.current;
    await act(async () => {
      jest.advanceTimersByTime(5000);
    });
    expect(live.result.current).toBeGreaterThanOrEqual(at + 4000);
    expect(frozen.result.current).toBe(at);
  });
});
