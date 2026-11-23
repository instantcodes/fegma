import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleResolveVideo } from './_lib/videoProxy';

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  await handleResolveVideo(req, res);
}
