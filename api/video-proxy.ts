import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleVideoProxy } from './_lib/videoProxy';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleVideoProxy(req, res);
}
