import client, { type ClientRequestConfig } from '../client';
import type { User } from '../../domain/types';

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  user: User;
}

/** _noAuth: a 401 here means bad credentials, never "try refresh". */
export async function login(username: string, password: string): Promise<LoginResponse> {
  const { data } = await client.post<LoginResponse>('/auth/login', { username, password }, {
    _noAuth: true,
  } as ClientRequestConfig);
  return data;
}

export async function refresh(refreshToken: string): Promise<{ access_token: string }> {
  const { data } = await client.post<{ access_token: string }>('/auth/refresh', null, {
    headers: { Authorization: `Bearer ${refreshToken}` },
    _noAuth: true,
  } as ClientRequestConfig);
  return data;
}

export async function logout(): Promise<void> {
  await client.post('/auth/logout');
}

export async function me(): Promise<User> {
  const { data } = await client.get<User>('/auth/me');
  return data;
}

export interface VerifyPinResponse {
  valid: boolean;
  manager_id?: string;
  manager_name?: string;
}

/** Rate-limited 5/min. 400 {valid:false} surfaces as ApiError status 400. */
export async function verifyPin(pin: string): Promise<VerifyPinResponse> {
  const { data } = await client.post<VerifyPinResponse>('/auth/verify-pin', { pin });
  return data;
}
