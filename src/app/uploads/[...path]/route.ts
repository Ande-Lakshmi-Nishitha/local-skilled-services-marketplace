// Serves uploaded portfolio photos from the uploads/ folder (or UPLOAD_DIR).
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const uploadDir = () => process.env.UPLOAD_DIR || join(/*turbopackIgnore: true*/ process.cwd(), 'uploads');
const TYPES: Record<string, string> = { jpg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export async function GET(_req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  // only "<worker id>/<uuid>.<ext>" - nothing else can be read
  if (path.length !== 2 || !/^\d+$/.test(path[0]) || !/^[a-f0-9-]{36}\.(jpg|png|webp)$/.test(path[1])) {
    return new Response('Not found', { status: 404 });
  }
  const ext = path[1].split('.').pop()!;
  try {
    const data = await readFile(join(/*turbopackIgnore: true*/ uploadDir(), path[0], path[1]));
    return new Response(new Uint8Array(data), {
      headers: { 'content-type': TYPES[ext], 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}
