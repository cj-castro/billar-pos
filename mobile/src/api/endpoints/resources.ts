import client from '../client';
import type { Resource } from '../../domain/types';

export async function listResources(opts: { includeInactive?: boolean } = {}): Promise<Resource[]> {
  const { data } = await client.get<Resource[]>('/resources', {
    params: opts.includeInactive ? { include_inactive: true } : undefined,
  });
  return data;
}
