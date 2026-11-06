import { APP_VERSION } from './version';
import { isBelowMin } from './versionGate';

/** What GET /api/v1/health told us (all optional: old servers only send `status`). */
export interface ServerInfo {
  server_version?: string;
  min_mobile_version?: string;
  features?: string[];
}

let info: ServerInfo = {};

export function setServerInfo(body: unknown) {
  const b = (body ?? {}) as Record<string, unknown>;
  info = {
    server_version: typeof b.server_version === 'string' ? b.server_version : undefined,
    min_mobile_version: typeof b.min_mobile_version === 'string' ? b.min_mobile_version : undefined,
    features: Array.isArray(b.features) ? b.features.filter((f): f is string => typeof f === 'string') : undefined,
  };
}

export const getServerInfo = (): ServerInfo => info;
export const serverSupports = (feature: string): boolean => !!info.features?.includes(feature);
export const updateRequired = (): boolean => isBelowMin(info.min_mobile_version, APP_VERSION);
