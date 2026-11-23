import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

const MAX_REDIRECTS = 5;
const UPSTREAM_TIMEOUT_MS = 20_000;
const CHUNK_RANGE_SIZE = 3 * 1024 * 1024; // 3 MB bounded chunks for Vercel serverless compatibility
const MAX_HTML_INSPECT_BYTES = 512 * 1024; // 512 KB cap for safe HTML inspection
const MAX_MANIFEST_BYTES = 1024 * 1024; // 1 MB cap for HLS .m3u8 manifest rewriting

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

const VIDEO_FILE_EXT_RE = /\.(mp4|webm|ogv|ogg|mov|m4v|m3u8|ts|m4s|m4a|aac|key)(\?|#|$)/i;
const HLS_EXT_RE = /\.m3u8(\?|#|$)/i;
const VALID_RANGE_RE = /^bytes=(\d+-\d*|-\d+)$/;

function isPrivateOrReservedIPv4(ip) {
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b, c] = parts;

  if (a === 0) return true;
  if (a === 10) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;

  return false;
}

function isPrivateOrReservedIPv6(ip) {
  const normalized = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (normalized === '::' || normalized === '::1') return true;

  const v4MappedMatch = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4MappedMatch) {
    return isPrivateOrReservedIPv4(v4MappedMatch[1]);
  }
  if (normalized.startsWith('::ffff:')) {
    return true;
  }

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

function isPublicIpAddress(ip) {
  const family = isIP(ip);
  if (family === 4) return !isPrivateOrReservedIPv4(ip);
  if (family === 6) return !isPrivateOrReservedIPv6(ip);
  return false;
}

/**
 * Validates that a target URL uses http/https on an allowed port, has no embedded credentials,
 * is not a local/internal host, and resolves exclusively to public routable IP addresses.
 * @param {string} rawUrl
 * @returns {Promise<URL>}
 */
export async function assertSafePublicUrl(rawUrl) {
  let parsed;
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

  if (isIP(hostname) !== 0) {
    if (!isPublicIpAddress(hostname)) {
      throw new Error('Access to private or reserved IP ranges is not permitted.');
    }
    return parsed;
  }

  let records;
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

async function sanitizeRefererOrigin(rawReferer) {
  if (!rawReferer) return undefined;
  try {
    const validated = await assertSafePublicUrl(rawReferer);
    return `${validated.origin}/`;
  } catch {
    return undefined;
  }
}

async function safeFetchFollowingRedirects(initialUrl, init) {
  let currentUrl = initialUrl;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const validatedUrl = await assertSafePublicUrl(currentUrl);
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: init.acceptHeader ?? '*/*',
    };

    if (init.rangeHeader) {
      headers.Range = init.rangeHeader;
    }

    if (init.refererOrigin) {
      headers.Referer = init.refererOrigin;
      headers.Origin = init.refererOrigin.replace(/\/$/, '');
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);

    let response;
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

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) {
        return { response, finalUrl: validatedUrl.href };
      }
      await response.body?.cancel().catch(() => {});
      currentUrl = new URL(location, validatedUrl.href).href;
      continue;
    }

    return { response, finalUrl: validatedUrl.href };
  }

  throw new Error('Too many redirects while reaching the video source.');
}

function normalizeProxyRange(rawRange, method, isManifestRequest) {
  // Never inject an unsolicited Range header (breaks HLS .m3u8, .ts segments, and AES keys)
  if (method === 'HEAD' || isManifestRequest || !rawRange) return undefined;

  const trimmed = rawRange.trim();
  if (!VALID_RANGE_RE.test(trimmed)) {
    return undefined;
  }

  // Cap open-ended browser Range requests (bytes=START-) to 3 MB chunks for Vercel compatibility
  const openMatch = trimmed.match(/^bytes=(\d+)-$/);
  if (openMatch) {
    const start = Number(openMatch[1]);
    if (Number.isSafeInteger(start) && start >= 0) {
      return `bytes=${start}-${start + CHUNK_RANGE_SIZE - 1}`;
    }
  }

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

function isHlsContentType(contentType, urlStr) {
  const lower = contentType.toLowerCase().split(';')[0].trim();
  if (
    lower === 'application/vnd.apple.mpegurl' ||
    lower === 'application/x-mpegurl' ||
    lower === 'audio/mpegurl' ||
    lower === 'audio/x-mpegurl'
  ) {
    return true;
  }
  if (
    HLS_EXT_RE.test(urlStr) &&
    (lower === '' || lower === 'text/plain' || lower === 'application/octet-stream')
  ) {
    return true;
  }
  return false;
}

function isDrmProtectedManifest(manifestText) {
  const lower = manifestText.toLowerCase();
  return (
    /\.drm(\?|#|\s|$)/i.test(manifestText) ||
    lower.includes('com.widevine') ||
    lower.includes('com.apple.streamingkeydelivery') ||
    lower.includes('com.microsoft.playready') ||
    lower.includes('method=sample-aes')
  );
}

function isAllowedMediaContentType(contentType, urlStr, contentLengthHeader) {
  const lower = contentType.toLowerCase().split(';')[0].trim();

  if (isHlsContentType(contentType, urlStr)) {
    return true;
  }

  if (
    lower.startsWith('video/') ||
    lower.startsWith('audio/') ||
    lower === 'application/mp4' ||
    lower === 'application/octet-stream' ||
    lower === 'binary/octet-stream' ||
    lower === 'application/binary' ||
    lower === 'application/x-binary' ||
    lower === 'application/pgp-keys'
  ) {
    return true;
  }

  // Allow 16-byte HLS AES-128 encryption keys or raw segments served as text/plain or empty type
  if ((lower === '' || lower === 'text/plain') && (VIDEO_FILE_EXT_RE.test(urlStr) || contentLengthHeader === '16')) {
    return true;
  }

  return false;
}

function inferMimeFromUrl(urlStr) {
  const lower = urlStr.toLowerCase();
  if (lower.includes('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (lower.includes('.webm')) return 'video/webm';
  if (lower.includes('.ogv') || lower.includes('.ogg')) return 'video/ogg';
  if (lower.includes('.mov')) return 'video/quicktime';
  if (lower.includes('.ts')) return 'video/mp2t';
  if (lower.includes('.m4s')) return 'video/iso.segment';
  return 'video/mp4';
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  res.end(JSON.stringify(payload));
}

function getQueryParam(req, key) {
  if (req && req.query && typeof req.query[key] === 'string') {
    return req.query[key].trim();
  }
  const raw = req?.url ?? '/';
  const parsed = new URL(raw, 'http://localhost');
  return parsed.searchParams.get(key)?.trim() ?? '';
}

function buildProxyLink(targetUrl, refererOrigin, kind) {
  const params = new URLSearchParams({ url: targetUrl });
  if (refererOrigin) {
    params.set('referer', refererOrigin);
  }
  if (kind === 'key') {
    params.set('kind', 'key');
  }
  return `/api/video-proxy?${params.toString()}`;
}

function rewriteHlsManifest(manifestText, baseUrl, refererOrigin) {
  const lines = manifestText.split(/\r?\n/);
  const baseParsed = new URL(baseUrl);

  const resolveAndWrap = (uri, kind) => {
    const trimmed = uri.trim();
    if (!trimmed) return trimmed;
    try {
      const abs = new URL(trimmed, baseUrl);
      if (abs.protocol !== 'http:' && abs.protocol !== 'https:') {
        return trimmed;
      }
      // Preserve parent manifest query-string auth tokens (e.g. Bunny bcdn_token / expires / token_path)
      // onto same-origin child playlists & segments that omit their own query string
      if (baseParsed.search && !abs.search && abs.origin === baseParsed.origin) {
        abs.search = baseParsed.search;
      }
      return buildProxyLink(abs.href, refererOrigin, kind);
    } catch {
      return trimmed;
    }
  };

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        if (trimmed.includes('URI="')) {
          const isKeyTag = trimmed.startsWith('#EXT-X-KEY');
          return line.replace(/URI="([^"]+)"/g, (_m, uriValue) => {
            return `URI="${resolveAndWrap(uriValue, isKeyTag ? 'key' : undefined)}"`;
          });
        }
        return line;
      }

      return resolveAndWrap(trimmed, undefined);
    })
    .join('\n');
}

async function readLimitedText(response, maxBytes) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const slice =
        total + value.byteLength > maxBytes ? value.subarray(0, maxBytes - total) : value;
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
 * Streams a validated remote video file or rewritten HLS .m3u8 playlist/segments
 * as a same-origin response so HTML5 <video> and captureStream() work without CORS errors.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function handleVideoProxy(req, res) {
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

  const refererOrigin = await sanitizeRefererOrigin(getQueryParam(req, 'referer') || undefined);
  const requestKind = getQueryParam(req, 'kind');
  const isKeyRequest = requestKind === 'key';
  const incomingRange = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const likelyManifest = !isKeyRequest && HLS_EXT_RE.test(targetUrl);
  const normalizedRange = normalizeProxyRange(incomingRange, method, likelyManifest || isKeyRequest);

  try {
    let { response, finalUrl } = await safeFetchFollowingRedirects(targetUrl, {
      method,
      rangeHeader: normalizedRange,
      refererOrigin,
      acceptHeader: isKeyRequest
        ? 'application/octet-stream, */*;q=0.5'
        : likelyManifest
          ? 'application/vnd.apple.mpegurl, application/x-mpegurl, text/plain, */*;q=0.5'
          : 'video/*, audio/*, application/octet-stream;q=0.9, */*;q=0.5',
    });

    if ((response.status === 416 || response.status === 400) && !incomingRange && method === 'GET') {
      await response.body?.cancel().catch(() => {});
      const retry = await safeFetchFollowingRedirects(targetUrl, {
        method: 'GET',
        refererOrigin,
        acceptHeader: 'video/*, audio/*, application/octet-stream;q=0.9, */*;q=0.5',
      });
      response = retry.response;
      finalUrl = retry.finalUrl;
    }

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      sendJson(res, response.status === 404 ? 404 : response.status === 403 ? 403 : 502, {
        error: isKeyRequest
          ? `Remote encryption key server returned HTTP ${response.status} (${new URL(finalUrl).hostname}). This stream restricts decryption keys to its official embedded player.`
          : `Remote media server returned HTTP ${response.status} for ${new URL(finalUrl).hostname}.`,
      });
      return;
    }

    const upstreamContentType = response.headers.get('content-type') ?? '';
    const upstreamContentLength = response.headers.get('content-length') ?? '';

    // Standard HLS AES-128 keys are strictly 16 raw bytes; read with a tiny byte cap to avoid unbounded buffering
    if (isKeyRequest && method === 'GET') {
      const reader = response.body?.getReader();
      const chunks = [];
      let total = 0;
      if (reader) {
        try {
          while (total <= 32) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            chunks.push(value);
            total += value.byteLength;
          }
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      if (total !== 16) {
        sendJson(res, 403, {
          error:
            'The remote encryption key endpoint did not return a valid 16-byte AES-128 key (this stream likely uses DRM or proprietary player authentication).',
        });
        return;
      }
      const keyBuf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/octet-stream');
      res.setHeader('Content-Length', '16');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(keyBuf);
      return;
    }

    if (!isAllowedMediaContentType(upstreamContentType, finalUrl, upstreamContentLength)) {
      await response.body?.cancel().catch(() => {});
      sendJson(res, 415, {
        error: `Remote URL returned "${upstreamContentType || 'unknown'}" instead of a direct playable video stream.`,
      });
      return;
    }

    if (isHlsContentType(upstreamContentType, finalUrl)) {
      if (method === 'HEAD') {
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('Cache-Control', 'private, no-store');
        res.end();
        return;
      }

      const rawManifest = await readLimitedText(response, MAX_MANIFEST_BYTES);
      if (!rawManifest.trimStart().startsWith('#EXTM3U')) {
        sendJson(res, 415, {
          error: 'Remote playlist response was not a valid HLS (#EXTM3U) manifest.',
        });
        return;
      }

      if (isDrmProtectedManifest(rawManifest)) {
        sendJson(res, 403, {
          error:
            'This stream uses DRM protection (such as MediaCage, Widevine, or FairPlay) which browsers cannot capture via HTML5 captureStream().',
        });
        return;
      }

      const rewritten = rewriteHlsManifest(rawManifest, finalUrl, refererOrigin);
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Cache-Control', 'private, no-store');
      res.end(rewritten);
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

    // Stream chunks directly using standard Web ReadableStream reader (universal across Node 18-24 & Vercel)
    const reader = response.body.getReader();
    let aborted = false;
    const onClose = () => {
      aborted = true;
      reader.cancel().catch(() => {});
    };
    req.on('close', onClose);

    try {
      while (!aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.byteLength > 0) {
          const canContinue = res.write(Buffer.from(value));
          if (!canContinue) {
            await new Promise((resolve) => res.once('drain', resolve));
          }
        }
      }
      if (!res.writableEnded) {
        res.end();
      }
    } finally {
      req.off('close', onClose);
      reader.cancel().catch(() => {});
    }
  } catch (err) {
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

function decodeHtmlEntities(input) {
  return input
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractDirectVideoCandidatesFromHtml(html, baseUrl) {
  const found = [];

  const pushCandidate = (raw) => {
    const cleaned = decodeHtmlEntities(raw.replace(/\\\//g, '/').replace(/\\u0026/gi, '&')).trim();
    if (!cleaned || cleaned.startsWith('data:') || cleaned.startsWith('blob:')) return;
    try {
      const resolved = new URL(cleaned, baseUrl).href;
      if (
        (resolved.startsWith('http://') || resolved.startsWith('https://')) &&
        !found.includes(resolved)
      ) {
        found.push(resolved);
      }
    } catch {
      // Ignore malformed candidate
    }
  };

  const patterns = [
    // HTML5 <video src="..."> and <source src="...">
    /<(?:video|source)[^>]+src=["']([^"']+)["']/gi,
    // OpenGraph & Twitter stream meta tags
    /<meta[^>]+(?:property|name)=["'](?:og:video:secure_url|og:video:url|og:video|twitter:player:stream)["'][^>]+content=["']([^"']+)["']/gi,
    /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:video:secure_url|og:video:url|og:video|twitter:player:stream)["']/gi,
    // JSON-LD "contentUrl"
    /"contentUrl"\s*:\s*"((?:https?:)?(?:\\\/|\/){2}[^"]+)"/gi,
    // Embedded HLS playlist URLs in player scripts (including Bunny Stream vz-*.b-cdn.net/.../playlist.m3u8)
    /["']((?:https?:)?(?:\\\/|\/){2}[^"'<>\s]+?\.m3u8(?:\?[^"'<>\s]*)?)["']/gi,
    // Embedded direct MP4 / WebM URLs in player scripts
    /["']((?:https?:)?(?:\\\/|\/){2}[^"'<>\s]+?\.(?:mp4|webm|mov|m4v)(?:\?[^"'<>\s]*)?)["']/gi,
  ];

  for (const regex of patterns) {
    let match;
    while ((match = regex.exec(html)) !== null) {
      pushCandidate(match[1]);
    }
  }

  const rank = (url) => {
    if (/\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(url)) return 0;
    if (HLS_EXT_RE.test(url)) return 1;
    return 2;
  };

  return found.sort((a, b) => rank(a) - rank(b));
}

/**
 * Inspects a user-supplied URL to determine whether it is a direct video file,
 * an HLS .m3u8 stream, or an HTML embed page exposing a playable HTML5/HLS stream.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @returns {Promise<void>}
 */
export async function handleResolveVideo(req, res) {
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
    const initialParsed = await assertSafePublicUrl(targetUrl);
    const { response, finalUrl } = await safeFetchFollowingRedirects(targetUrl, {
      method: 'GET',
      refererOrigin: `${initialParsed.origin}/`,
      acceptHeader:
        'text/html, application/xhtml+xml, video/*, application/vnd.apple.mpegurl, */*;q=0.8',
    });

    if (!response.ok && response.status !== 206) {
      await response.body?.cancel().catch(() => {});
      sendJson(res, 200, {
        ok: false,
        error: `Remote server returned HTTP ${response.status} when checking this URL (token may be expired or access restricted).`,
      });
      return;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    const contentLength = response.headers.get('content-length') ?? '';

    if (isAllowedMediaContentType(contentType, finalUrl, contentLength)) {
      const hls = isHlsContentType(contentType, finalUrl);
      await response.body?.cancel().catch(() => {});
      sendJson(res, 200, {
        ok: true,
        kind: 'direct',
        streamFormat: hls ? 'hls' : 'file',
        resolvedUrl: finalUrl,
        contentType: contentType.split(';')[0].trim() || inferMimeFromUrl(finalUrl),
      });
      return;
    }

    if (contentType.includes('text/html') || contentType.includes('application/xhtml')) {
      const html = await readLimitedText(response, MAX_HTML_INSPECT_BYTES);
      const embedOrigin = `${new URL(finalUrl).origin}/`;
      const candidates = extractDirectVideoCandidatesFromHtml(html, finalUrl);

      let foundDrmStream = false;

      for (const candidate of candidates.slice(0, 8)) {
        try {
          const isCandidateHls = HLS_EXT_RE.test(candidate);
          const probe = await safeFetchFollowingRedirects(candidate, {
            method: isCandidateHls ? 'GET' : 'HEAD',
            refererOrigin: embedOrigin,
            acceptHeader: isCandidateHls
              ? 'application/vnd.apple.mpegurl, application/x-mpegurl, text/plain, */*'
              : 'video/*, audio/*, application/octet-stream;q=0.9',
          });

          const probeType = (probe.response.headers.get('content-type') ?? '').toLowerCase();
          const probeLength = probe.response.headers.get('content-length') ?? '';
          if (probe.response.ok || probe.response.status === 206) {
            if (isHlsContentType(probeType, probe.finalUrl)) {
              const snippet = await readLimitedText(probe.response, 8192);
              if (snippet.trimStart().startsWith('#EXTM3U')) {
                if (isDrmProtectedManifest(snippet)) {
                  foundDrmStream = true;
                  continue;
                }
                sendJson(res, 200, {
                  ok: true,
                  kind: 'extracted',
                  streamFormat: 'hls',
                  resolvedUrl: probe.finalUrl,
                  refererOrigin: embedOrigin,
                  contentType: 'application/vnd.apple.mpegurl',
                });
                return;
              }
            } else if (isAllowedMediaContentType(probeType, probe.finalUrl, probeLength)) {
              await probe.response.body?.cancel().catch(() => {});
              sendJson(res, 200, {
                ok: true,
                kind: 'extracted',
                streamFormat: 'file',
                resolvedUrl: probe.finalUrl,
                refererOrigin: embedOrigin,
                contentType: probeType.split(';')[0].trim() || inferMimeFromUrl(probe.finalUrl),
              });
              return;
            }
          }
          await probe.response.body?.cancel().catch(() => {});
        } catch {
          // Try next discovered candidate
        }
      }

      sendJson(res, 200, {
        ok: false,
        error: foundDrmStream
          ? 'This embed link uses DRM-protected streaming (MediaCage / Widevine / FairPlay), which cannot be captured via HTML5 captureStream(). Use an unprotected direct .mp4/.webm/.m3u8 video URL or a local file.'
          : 'This webpage did not expose an accessible HTML5 video or HLS stream (it may require an expired token, domain-locked referrer, or DRM decryption). Provide a direct .mp4/.webm/.m3u8 link or a valid unprotected embed link.',
      });
      return;
    }

    await response.body?.cancel().catch(() => {});
    sendJson(res, 200, {
      ok: false,
      error: `This URL returned "${contentType || 'unknown content'}" rather than a playable video file.`,
    });
  } catch (err) {
    const message =
      err instanceof Error && err.name === 'AbortError'
        ? 'Timed out while inspecting the remote URL.'
        : err instanceof Error
          ? err.message
          : 'Unable to inspect the remote video URL.';
    sendJson(res, 200, { ok: false, error: message });
  }
}
