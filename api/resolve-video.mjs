import { handleResolveVideo } from './_lib/videoProxy.mjs';

export default async function handler(req, res) {
  try {
    await handleResolveVideo(req, res);
  } catch (err) {
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          ok: false,
          error: err instanceof Error ? err.message : 'Unexpected media resolver error.',
        })
      );
    }
  }
}
