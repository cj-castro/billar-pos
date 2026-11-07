import client from '../client';
import type { MenuCategory, MenuItem, ModifierGroup } from '../../domain/types';

export async function listCategories(): Promise<MenuCategory[]> {
  const { data } = await client.get<MenuCategory[]>('/menu/categories');
  return data;
}

export async function listItems(params: { category_id?: string; include_inactive?: boolean } = {}): Promise<MenuItem[]> {
  const { data } = await client.get<MenuItem[]>('/menu/items', { params });
  return data;
}

export async function listModifiers(): Promise<ModifierGroup[]> {
  const { data } = await client.get<ModifierGroup[]>('/menu/modifiers');
  return data;
}
