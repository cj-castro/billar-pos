import client from '../client';
import type { Setting } from '../../domain/types';

export async function getSetting(key: string): Promise<Setting> {
  const { data } = await client.get<Setting>(`/settings/${key}`);
  return data;
}

/** MANAGER/ADMIN only (403 {error:"Forbidden"} otherwise). */
export async function putSetting(key: string, value: string): Promise<Setting> {
  const { data } = await client.put<Setting>(`/settings/${key}`, { value });
  return data;
}
