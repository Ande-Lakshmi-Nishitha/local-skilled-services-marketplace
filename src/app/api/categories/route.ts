// GET /api/categories
import { json } from '@/lib/api';
import { listCategories } from '@/lib/services/catalogue';

export const GET = () => json(() => listCategories());
