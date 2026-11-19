// POST /api/requests  { description }  -> 201 { request_id }      (customer)
// GET  /api/requests                   -> the customer's requests
import { apiRole, body, json } from '@/lib/api';
import { createRequest, listRequests } from '@/lib/services/requests';

export async function POST(req: Request) {
  return json(async () => {
    const s = await apiRole('customer');
    const b = await body(req);
    return { request_id: await createRequest(s.id, String(b.description ?? '')), status: 'open' };
  }, 201);
}

export async function GET() {
  return json(async () => listRequests((await apiRole('customer')).id));
}
