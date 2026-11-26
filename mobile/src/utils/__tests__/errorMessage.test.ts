import { ApiError } from '../../api/client';
import i18n from '../../i18n';
import { errorCode, errorKind, errorMessage } from '../errorMessage';

const http = (status: number, code = `HTTP_${status}`) => new ApiError({ status, code, message: 'raw server text <html>' });

describe('errorMessage', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('es');
  });

  it.each([
    [new ApiError({ code: 'NETWORK_ERROR', message: '', isNetwork: true }), 'network', 'No hay conexión con el servidor. Revisa el Wi-Fi e inténtalo de nuevo.'],
    [new ApiError({ code: 'TIMEOUT', message: '', isTimeout: true }), 'timeout', 'El servidor tardó demasiado en responder. Inténtalo de nuevo.'],
    [http(401), 'unauthorized', 'Tu sesión expiró. Entra de nuevo.'],
    [http(403), 'forbidden', 'No tienes permiso para eso.'],
    [http(404), 'notFound', 'No encontramos lo que buscas.'],
    [http(409), 'conflict', 'Alguien más cambió esto. Actualiza e inténtalo de nuevo.'],
    [http(422), 'validation', 'Revisa los datos e inténtalo de nuevo.'],
    [http(429), 'rateLimit', 'Demasiados intentos, espera un momento.'],
    [http(500), 'server', 'El servidor tuvo un problema (500).'],
    [http(503), 'server', 'El servidor tuvo un problema (503).'],
  ])('maps %# to Spanish', (err, kind, text) => {
    expect(errorKind(err)).toBe(kind);
    expect(errorMessage(err)).toBe(text);
  });

  it('never leaks the raw server message', () => {
    expect(errorMessage(http(500))).not.toContain('html');
  });

  it('falls back to generic for unknown / non-API errors', () => {
    expect(errorMessage(new Error('boom'))).toBe('Ocurrió un error inesperado.');
    expect(errorMessage('weird')).toBe('Ocurrió un error inesperado.');
  });

  it('screen-specific overrides win by error code', () => {
    expect(errorMessage(http(403, 'BAR_CLOSED'), { BAR_CLOSED: 'El bar está cerrado.' })).toBe('El bar está cerrado.');
    expect(errorMessage(http(403, 'OTHER'), { BAR_CLOSED: 'x' })).toBe('No tienes permiso para eso.');
  });

  it('follows the current language', async () => {
    await i18n.changeLanguage('en');
    expect(errorMessage(http(403))).toBe('You do not have permission for that.');
  });

  it('exposes a support code', () => {
    expect(errorCode(http(500))).toBe('HTTP_500');
    expect(errorCode(new ApiError({ code: 'NETWORK_ERROR', message: '', isNetwork: true }))).toBe('NETWORK_ERROR');
  });
});
