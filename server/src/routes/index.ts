import { createResistanceBlocksHandler } from './resistanceBlocks.js';

interface NodeRequest {
  method?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, listener: (chunk: unknown) => void): void;
}

interface NodeResponse {
  writeHead(status: number, headers: Record<string, string>): void;
  end(body: string): void;
}

export function createApiRouter(supabase: unknown, cors: Record<string, string>) {
  const resistanceBlocks = createResistanceBlocksHandler(
    supabase as Parameters<typeof createResistanceBlocksHandler>[0],
    cors,
  );

  return async function handleApiRequest(req: NodeRequest, res: NodeResponse): Promise<boolean> {
    const url = req.url ?? '';

    const PREFIX = '/api/resistance-blocks';
    if (url === PREFIX || url.startsWith(PREFIX + '/') || url.startsWith(PREFIX + '?')) {
      const subpath = url.slice(PREFIX.length).split('?')[0];
      return resistanceBlocks(req, res, subpath);
    }

    return false;
  };
}
