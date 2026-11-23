import { lookup } from 'node:dns/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { Readable } from 'node:stream';

const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 20_000;
const CHUNK_RANGE_SIZE = 3 * 1024 * 1024; // 3 MB bounded chunks for Vercel serverless compatibility
const MAX_HTML_INSPECT_BYTES = 512 * 1024; // 512 KB cap for safe HTML video-tag inspection

const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443']);

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '::1',
  '::',
  'metadata',
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
]);

const VIDEO_FILE_EXT_RE = /\.(mp4|webm|ogv|ogg|mov|m4v|m3u8)(\?|#|$)/i;
const VALID_RANGE_RE = /^bytes=(\d+-\d*|-\d+)$/;

function isPrivateOrReservedIPv4(ip: string): boolean {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;

  if (a === 0) return true; // 0.0.0.0/8 unspecified
  if (a === 10) return true; // 10.0.0.0/8 RFC1918
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local / cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 RFC1918
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 RFC1918
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true; // IETF / TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // Benchmark
  if (a >= 224) return true; // Multicast & reserved

  return false;
}

function isPrivateOrReservedIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1') return true;

  // Handle IPv4-mapped IPv6 addresses like ::ffff:127.0.0.1
  const v4MappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    return isPrivateOrReservedIPv4(v4MappedMatch[1]);
  }

  // Handle hex IPv4-mapped form ::ffff:7f00:1
  if (normalized.startsWith('::ffff:')) {
    return true;
  }

  // Unique local fc00::/7, link-local fe80::/10, multicast ff00::/8, NAT64 64:ff9b::, 6to4 2002::, doc 2001:db8::
  if (
    normalized.startsWith('fc') ||
    normalized.startsWith('fd') ||
    normalized.startsWith('fe8') ||
    normalized.startsWith('fe9') ||
    normalized.startsWith('fea') ||
    normalized.startsWith('feb') ||
    normalized.startsWith('ff') ||
    normalized.startsWith('64:ff9b:') ||
    normalized.startsWith('2002:') ||
    normalized.startsWith('2001:db8:')
  ) {
    return true;
  }

  return false;
}

function isPublicIpAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !isPrivateOrReservedIPv4(ip);
  if (family === 6) return !isPrivateOrReservedIPv6(ip);
  return false;
}

/**
 * Validates that a target URL uses http/https on an allowed port, has no embedded credentials,
 * is not a local/internal host, and resolves exclusively to public routable IP addresses.
 */
export async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL format.');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http:// and https:// URLs are supported.');
  }

  if (parsed.username || parsed.password) {
    throw new Error('URLs containing embedded credentials are not allowed.');
  }

  if (!ALLOWED_PORTS.has(parsed.port)) {
    throw new Error('This URL uses a non-standard port that is not permitted.');
  }

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (
    !hostname ||
    BLOCKED_HOSTNAMES.has(hostname) ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal')
  ) {
    throw new Error('Access to local or internal network addresses is not permitted.');
  }

  // Direct IP literal check
  if (isIP(hostname) !== 0) {
    if (!isPublicIpAddress(hostname)) {
      throw new Error('Access to private or reserved IP ranges is not permitted.');
    }
    return parsed;
  }

  // Resolve DNS and confirm every returned IP is globally routable
  let records: Array<{ address: string; family: number }>;
  try {
    records = await lookup(hostname, { all: true });
  } catch {
    throw new Error('Could not resolve the video server hostname.');
  }

  if (!records || records.length === 0) {
    throw new Error('No DNS records found for the video server hostname.');
  }

  for (const record of records) {
    if (!isPublicIpAddress(record.address)) {
      throw new Error('The target host resolved to a restricted network address.');
    }
  }

  return parsed;
}

async function safeFetchFollowingRedirects(
  initialUrl: string,
  init: {
    method: 'GET' | 'HEAD';
    rangeHeader?: string;
    acceptHeader?: string;
  }
): Promise<{ response: Response; finalUrl: string }> {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const validatedUrl = await assertSafePublicUrl(currentUrl);
    const headers: Record<string, string> = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: init.acceptHeader ?? '*/*',
    };

    if (init.rangeHeader) {
      headers.Range = init.rangeHeader;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(validatedUrl.href, {
        method: init.method,
        headers,
        redirect: 'manual',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    // Manually validate and follow 3xx redirects
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { response, finalUrl: validatedUrl.href };
      }
      // Cancel redirect body before next hop
      await response.body?.cancel().catch(() => {});
      currentUrl = new URL(location, validatedUrl.href).href;
      continue;
    }

    return { response, finalUrl: validatedUrl.href };
  }

  throw new Error('Too many redirects while reaching the video source.');
}

function normalizeProxyRange(rawRange: string | undefined, method: 'GET' | 'HEAD'): string | undefined {
  if (method === 'HEAD') return undefined;

  if (!rawRange) {
    // Request a bounded first chunk so upstream returns 206 Partial Content with full total size
    return `bytes=0-${CHUNK_RANGE_SIZE - 1}`;
  }

  const trimmed = rawRange.trim();
  if (!VALID_RANGE_RE.test(trimmed)) {
    return `bytes=0-${CHUNK_RANGE_SIZE - 1}`;
  }

  // Cap open-ended ranges (bytes=START-) to 3 MB so serverless streaming stays within body limits
  const openMatch = trimmed.match(/^bytes=(\d+)-$/);
  if (openMatch) {
    const start = Number(openMatch[1]);
    if (Number.isSafeInteger(start) && start >= 0) {
      return `bytes=${start}-${start + CHUNK_RANGE_SIZE - 1}`;
    }
  }

  // Also cap overly wide explicit ranges (bytes=START-END) to 3 MB
  const boundedMatch = trimmed.match(/^bytes=(\d+)-(\d+)$/);
  if (boundedMatch) {
    const start = Number(boundedMatch[1]);
    const end = Number(boundedMatch[2]);
    if (Number.isSafeInteger(start) && Number.isSafeInteger(end) && end >= start) {
      const cappedEnd = Math.min(end, start + CHUNK_RANGE_SIZE - 1);
      return `bytes=${start}-${cappedEnd}`;
    }
  }

  return trimmed;
}

function isAllowedMediaContentType(contentType: string, urlStr: string): boolean {
  const lower = contentType.toLowerCase().split(';')[0].trim();

  if (
    lower.startsWith('video/') ||
    lower.startsWith('audio/') ||
    lower === 'application/mp4' ||
    lower === 'application/vnd.apple.mpegurl' ||
    lower === 'application/x-mpegurl'
  ) {
    return true;
  }

  // Many CDNs serve .mp4/.webm files as application/octet-stream
  if (lower === 'application/octet-stream' || lower === 'binary/octet-stream') {
    return true;
  }

  // Allow empty content-type only when URL ends with a known video file extension
  if (!lower && VIDEO_FILE_EXT_RE.test(urlStr)) {
    return true;
  }

  return false;
}

function inferMimeFromUrl(urlStr: string): string {
  const lower = urlStr.toLowerCase();
  if (lower.includes('.webm')) return 'video/webm';
  if (lower.includes('.ogv') || lower.includes('.ogg')) return 'video/ogg';
  if (lower.includes('.mov')) return 'video/quicktime';
  if (lower.includes('.m3u8')) return 'application/vnd.apple.mpegurl';
  return 'video/mp4';
}

function sendJson(res: ServerResponse, status: number, payload: Record<string, unknown>): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(payload));
}

function getQueryParam(req: IncomingMessage, key: string): string {
  const raw = req.url ?? '/';
  const parsed = new URL(raw, 'http://localhost');
  return parsed.searchParams.get(key)?.trim() ?? '';
}

/**
 * Streams a validated remote direct video URL as a same-origin response with Range support,
 * enabling HTML5 playback and captureStream() even when upstream servers omit CORS headers.
 */
export async function handleVideoProxy(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const method = req.method === 'HEAD' ? 'HEAD' : req.method === 'GET' ? 'GET' : null;
  if (!method) {
    sendJson(res, 405, { error: 'Only GET and HEAD requests are supported.' });
    return;
  }

  const targetUrl = getQueryParam(req, 'url');
  if (!targetUrl) {
    sendJson(res, 400, { error: 'Missing required "url" query parameter.' });
    return;
  }

  const incomingRange = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const normalizedRange = normalizeProxyRange(incomingRange, method);

  try {
    let { response, finalUrl } = await safeFetchFollowingRedirects(targetUrl, {
      method,
      rangeHeader: normalizedRange,
      acceptHeader: 'video/*, audio/*, application/octet-stream;q=0.9, */*;q=0.5',
    });

    // Some servers return 416 or reject Range headers; retry once without Range if client didn't ask for one
    if ((response.status === 416 || response.status === 400) && !incomingRange && method === 'GET') {
      await response.body?.cancel().catch(() => {});
      const retry = await safeFetchFollowingRedirects(targetUrl, {
        method: 'GET',
        acceptHeader: 'video/*, audio/*, application/octet-stream;q=0.9, */*;q=0.5',
      });
      response = retry.response;
      finalUrl = retry.finalUrl;
    }

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      sendJson(res, response.status === 404 ? 404 : 502, {
        error: `Remote media server returned HTTP ${response.status}.`,
      });
      return;
    }

    const upstreamContentType = response.headers.get('content-type') ?? '';
    if (!isAllowedMediaContentType(upstreamContentType, finalUrl)) {
      await response.body?.cancel().catch(() => {});
      sendJson(res, 415, {
        error: `Remote URL returned "${upstreamContentType || 'unknown'}" instead of a direct playable video stream.`,
      });
      return;
    }

    const safeContentType =
      !upstreamContentType ||
      upstreamContentType.toLowerCase().startsWith('application/octet-stream') ||
      upstreamContentType.toLowerCase().startsWith('binary/octet-stream')
        ? inferMimeFromUrl(finalUrl)
        : upstreamContentType;

    res.statusCode = response.status;
    res.setHeader('Content-Type', safeContentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');

    const contentLength = response.headers.get('content-length');
    const contentRange = response.headers.get('content-range');
    const acceptRanges = response.headers.get('accept-ranges');
    const etag = response.headers.get('etag');
    const lastModified = response.headers.get('last-modified');

    if (contentLength) res.setHeader('Content-Length', contentLength);
    if (contentRange) res.setHeader('Content-Range', contentRange);
    res.setHeader('Accept-Ranges', acceptRanges || 'bytes');
    if (etag) res.setHeader('ETag', etag);
    if (lastModified) res.setHeader('Last-Modified', lastModified);

    if (method === 'HEAD' || !response.body) {
      res.end();
      return;
    }

    // Stream upstream chunks directly to the HTTP response
    const nodeStream = Readable.fromWeb(
      response.body as unknown as import('node:stream/web').ReadableStream
    );

    const onClientClose = () => {
      nodeStream.destroy();
    };
    req.on('close', onClientClose);

    await new Promise<void>((resolve, reject) => {
      nodeStream.on('error', reject);
      res.on('error', reject);
      res.on('finish', resolve);
      nodeStream.pipe(res);
    }).finally(() => {
      req.off('close', onClientClose);
    });
  } catch (err: unknown) {
    if (!res.headersSent) {
      const message =
        err instanceof Error && err.name === 'AbortError'
          ? 'Timed out waiting for the remote video server to respond.'
          : err instanceof Error
            ? err.message
            : 'Unable to proxy remote video stream.';
      sendJson(res, 400, { error: message });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractDirectVideoCandidatesFromHtml(html: string, baseUrl: string): string[] {
  const found: string[] = [];
  const patterns: RegExp[] = [
    // OpenGraph & Twitter stream meta tags
    /<meta[^>]+(?:property|name)=["'](?:og:video:secure_url|og:video:url|og:video|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video:secure_url|og:video:url|og:video|twitter:player:stream)["']/gi,
    // HTML5 <video src="..."> and <source src="...">
    /<(?:video|source)[^>]+src=["']([^"']+)["']/gi,
    // JSON-LD "contentUrl": "https://...mp4"
    /"contentUrl"\s*:\s*"(https?:\\\/\\\/[^"]+|https?:\/\/[^"]+)"/gi,
  ];

  for (const regex of patterns) {
    let match: RegExpExecArray | null;
    while ((match = regex.exec(html)) !== null) {
      const rawCandidate = decodeHtmlEntities(match[1].replace(/\\\//g, '/')).trim();
      if (!rawCandidate || rawCandidate.startsWith('data:') || rawCandidate.startsWith('blob:')) {
        continue;
      }
      try {
        const resolved = new URL(rawCandidate, baseUrl).href;
        if (!found.includes(resolved)) {
          found.push(resolved);
        }
      } catch {
        // Ignore malformed relative candidates
      }
    }
  }

  // Prioritize URLs that clearly look like direct MP4/WebM/OGV/MOV media files
  return found.sort((a, b) => {
    const aDirect = VIDEO_FILE_EXT_RE.test(a) ? 0 : 1;
    const bDirect = VIDEO_FILE_EXT_RE.test(b) ? 0 : 1;
    return aDirect - bDirect;
  });
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const slice = total + value.byteLength > maxBytes ? value.subarray(0, maxBytes - total) : value;
      chunks.push(slice);
      total += slice.byteLength;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(combined);
}

/**
 * Inspects a user-supplied URL to determine whether it is a direct video stream
 * or an HTML webpage exposing a direct playable HTML5 video URL.
 */
export async function handleResolveVideo(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') {
    sendJson(res, 405, { ok: false, error: 'Only GET requests are supported.' });
    return;
  }

  const targetUrl = getQueryParam(req, 'url');
  if (!targetUrl) {
    sendJson(res, 400, { ok: false, error: 'Missing required "url" query parameter.' });
    return;
  }

  try {
    const { response, finalUrl } = await safeFetchFollowingRedirects(targetUrl, {
      method: 'GET',
      rangeHeader: 'bytes=0-65535',
      acceptHeader: 'video/*, text/html;q=0.9, */*;q=0.5',
    });

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      sendJson(res, 200, {
        ok: false,
        error: `Remote server returned HTTP ${response.status} when checking this URL.`,
      });
      return;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();

    if (isAllowedMediaContentType(contentType, finalUrl)) {
      await response.body?.cancel().catch(() => {});
      sendJson(res, 200, {
        ok: true,
        kind: 'direct',
        resolvedUrl: finalUrl,
        contentType: contentType.split(';')[0].trim() || inferMimeFromUrl(finalUrl),
      });
      return;
    }

    if (contentType.includes('text/html')) {
      const html = await readLimitedText(response, MAX_HTML_INSPECT_BYTES);
      const candidates = extractDirectVideoCandidatesFromHtml(html, finalUrl);

      for (const candidate of candidates.slice(0, 5)) {
        try {
          const probe = await safeFetchFollowingRedirects(candidate, {
            method: 'HEAD',
            acceptHeader: 'video/*, audio/*, application/octet-stream;q=0.9',
          });
          const probeType = (probe.response.headers.get('content-type') ?? '').toLowerCase();
          await probe.response.body?.cancel().catch(() => {});

          if ((probe.response.ok || probe.response.status === 206) && isAllowedMediaContentType(probeType, probe.finalUrl)) {
            sendJson(res, 200, {
              ok: true,
              kind: 'extracted',
              resolvedUrl: probe.finalUrl,
              contentType: probeType.split(';')[0].trim() || inferMimeFromUrl(probe.finalUrl),
            });
            return;
          }
        } catch {
          // Try next candidate if any
        }
      }

      sendJson(res, 200, {
        ok: false,
        error:
          'This link points to an HTML webpage without a publicly accessible direct HTML5 video file (for example, a DRM-protected or JavaScript-rendered streaming player). Paste a direct .mp4/.webm video link or load a local video file.',
      });
      return;
    }

    await response.body?.cancel().catch(() => {});
    sendJson(res, 200, {
      ok: false,
      error: `This URL returned "${contentType || 'unknown content'}" rather than a playable video file.`,
    });
  } catch (err: unknown) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? 'Timed out while inspecting the remote URL.'
        : err instanceof Error
          ? err.message
          : 'Unable to inspect the remote video URL.';
    sendJson(res, 200, { ok: false, error: message });
  }
}
