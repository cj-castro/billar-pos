import { act, renderHook } from '@testing-library/react-native';
import { useUpdater } from '../UpdateUi';
import { downloadUpdate, launchInstaller } from '../updater';

jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('../updater', () => ({ checkForUpdate: jest.fn(), updatesConfigured: () => true, downloadUpdate: jest.fn(), launchInstaller: jest.fn() }));

const found = { version: '1.2.0', build: 5, apk: 'x.apk', notes: '', sha256: '', md5: 'a'.repeat(32), apkUrl: 'http://h/x.apk' };

describe('useUpdater install', () => {
  it('goes to "ready" after download without awaiting the installer promise (Cancel never resolves it)', async () => {
    (downloadUpdate as jest.Mock).mockResolvedValue(undefined);
    (launchInstaller as jest.Mock).mockReturnValue(new Promise(() => {})); // never settles
    const { result } = await renderHook(() => useUpdater());
    const { checkForUpdate } = jest.requireMock('../updater');
    checkForUpdate.mockResolvedValue(found);
    await act(async () => { await result.current.check(true); });
    await act(async () => { await result.current.install(); });
    expect(result.current.ready).toBe(true);
    expect(result.current.busy).toBeNull();
    expect(result.current.open).toBe(true);
    expect(launchInstaller).toHaveBeenCalledTimes(1);
    // "Instalar" again re-launches without re-downloading
    await act(async () => { await result.current.install(); });
    expect(launchInstaller).toHaveBeenCalledTimes(2);
    expect(downloadUpdate).toHaveBeenCalledTimes(1);
  });
});
