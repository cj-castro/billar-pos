import client from '../client';

export interface HealthResponse {
  status: 'ok' | string;
  server_version?: string;
  min_mobile_version?: string;
  features?: string[];
}

export async function health(): Promise<HealthResponse> {
  const { data } = await client.get<HealthResponse>('/health');
  return data;
}
