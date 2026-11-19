import { q } from '../db';

export interface Category { category_id: number; name: string }

export const listCategories = () =>
  q<Category>('SELECT category_id, name FROM service_category ORDER BY name');

export async function listLocalities(): Promise<string[]> {
  const rows = await q<{ locality: string }>(
    `SELECT DISTINCT locality FROM worker WHERE verification_status = 'verified' ORDER BY locality`);
  return rows.map((r) => r.locality);
}
