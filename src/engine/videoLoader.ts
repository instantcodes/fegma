import { detectBrowserCapabilities } from './codecDetector';
import type { SampleVideoItem } from './types';

/**
 * Built-in sample video sources:
 * - Direct CORS-enabled MP4 samples hosted on Google Cloud Storage (`Access-Control-Allow-Origin: *`)
 * - An offline-safe procedural Broadcast Test Signal generated locally in-browser as a WebM Blob
 */
export const SAMPLE_VIDEO_CLIPS: SampleVideoItem[] = [
  {
    id: 'synthetic-broadcast',
    title: 'Broadcast Test Signal (Offline)',
    description: 'Locally generated 8s 720p SMPTE sweep with frame counter & audio pulse',
    durationHint: '00:08',
    url: '',
    type: 'synthetic',
  },
  {
    id: 'mdn-flower-mp4',
    title: 'Blooming Flower (Direct MP4)',
    description: 'Public CC0 MP4 clip (automatically proxied if server omits CORS)',
    durationHint: '00:05',
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4',
    type: 'sample',
  },
  {
    id: 'mdn-flower-webm',
    title: 'Blooming Flower (Direct WebM)',
    description: 'Public CC0 WebM clip for testing WebM capture & pause/resume',
    durationHint: '00:05',
    url: 'https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.webm',
    type: 'sample',
  },
];

export interface UrlValidationResult {
  valid: boolean;
  normalizedUrl: string;
  error?: string;
}

/**
 * Validates that a user-supplied video URL uses a safe, browser-playable protocol
 * and catches obvious non-direct webpage URLs before attempting load.
 */
export function validateVideoUrl(rawUrl: string): UrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return {
      valid: false,
      normalizedUrl: '',
      error: 'Enter a direct video URL (such as .mp4, .webm, or .ogv) before loading.',
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return {
      valid: false,
      normalizedUrl: '',
      error: 'Invalid URL format. Include the full protocol, e.g. https://example.com/video.mp4',
    };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:' && parsed.protocol !== 'blob:') {
    return {
      valid: false,
      normalizedUrl: '',
      error: 'Only http://, https://, and local blob: video URLs are supported.',
    };
  }

  const host = parsed.hostname.toLowerCase();
  const drmOnlyHosts = ['netflix.com', 'disneyplus.com', 'hulu.com', 'max.com', 'primevideo.com'];
  if (drmOnlyHosts.some((domain) => host === domain || host.endsWith(`.${domain}`))) {
    return {
      valid: false,
      normalizedUrl: '',
      error:
        'Subscription DRM streaming platforms cannot be loaded into an HTML5 video element. Provide a direct video URL (.mp4 / .webm) or load a local video file.',
    };
  }

  return {
    valid: true,
    normalizedUrl: parsed.href,
  };
}

/**
 * Builds the same-origin streaming media proxy URL so remote videos without CORS headers
 * can play inside HTML5 <video> and be captured via captureStream() cleanly.
 */
export function buildSameOriginProxyUrl(remoteUrl: string): string {
  return `/api/video-proxy?url=${encodeURIComponent(remoteUrl)}`;
}

export interface VideoResolveResponse {
  ok: boolean;
  kind?: 'direct' | 'extracted';
  resolvedUrl?: string;
  contentType?: string;
  error?: string;
}

/**
 * Calls the same-origin resolver endpoint to verify a remote video URL or extract
 * a direct HTML5 video source from an HTML page containing <video> / og:video tags.
 */
export async function resolveRemoteVideoUrl(remoteUrl: string): Promise<VideoResolveResponse> {
  try {
    const response = await fetch(`/api/resolve-video?url=${encodeURIComponent(remoteUrl)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) {
      return {
        ok: false,
        error: `Media resolver returned HTTP ${response.status}.`,
      };
    }
    const data = (await response.json()) as VideoResolveResponse;
    return data;
  } catch {
    return {
      ok: false,
      error: 'Could not reach the same-origin media proxy service.',
    };
  }
}

/**
 * Translates HTMLMediaElement MediaError codes into clear, honest diagnostics.
 */
export function classifyVideoLoadError(video: HTMLVideoElement, sourceUrl: string): string {
  const err = video.error;
  const isRemote = sourceUrl.startsWith('http://') || sourceUrl.startsWith('https://');

  if (!err) {
    return 'Unable to load the video stream. Verify the URL points directly to a playable media file.';
  }

  switch (err.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return 'Video loading was cancelled before playback could begin.';
    case MediaError.MEDIA_ERR_NETWORK:
      return isRemote
        ? 'Network error while fetching the video. The remote server may be unreachable, offline, or blocking cross-origin (CORS) requests required for stream capture.'
        : 'Network error while reading the video source.';
    case MediaError.MEDIA_ERR_DECODE:
      return 'The video file was downloaded, but this browser could not decode its video or audio codec.';
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return isRemote
        ? 'This URL could not be loaded as a CORS-accessible HTML5 video. The server may not send Access-Control-Allow-Origin headers, or the link points to an HTML webpage instead of a direct .mp4/.webm file.'
        : 'Unsupported video format. Try an MP4 (H.264/AAC) or WebM (VP8/VP9/Opus) file.';
    default:
      return 'An unexpected media playback error occurred while loading the video.';
  }
}

/**
 * Synthesizes an 8-second 1280x720 Broadcast Test Signal clip (SMPTE bars, sweeping radar line,
 * frame/timecode readout, and gentle 440Hz/880Hz Web Audio sync ticks) into a local WebM Blob URL.
 * Works 100% offline with zero CORS restrictions so stream capture can always be verified.
 */
export async function generateBroadcastTestClip(
  onProgress?: (percent: number) => void
): Promise<{ objectUrl: string; label: string }> {
  const durationMs = 8000;
  const width = 1280;
  const height = 720;
  const fps = 30;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('Canvas 2D context is unavailable to generate the broadcast test clip.');
  }

  const canvasStream = canvas.captureStream(fps);
  const combinedTracks: MediaStreamTrack[] = [...canvasStream.getVideoTracks()];

  // Synthesize gentle broadcast audio sync ticks via Web Audio API
  let audioCtx: AudioContext | null = null;
  let audioTimer: number | null = null;
  try {
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      audioCtx = new AudioCtx();
      const destination = audioCtx.createMediaStreamDestination();

      const playTick = (freq: number, lengthSec: number, gainPeak: number) => {
        if (!audioCtx || audioCtx.state === 'closed') return;
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(gainPeak, audioCtx.currentTime + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + lengthSec);
        osc.connect(gain);
        gain.connect(destination);
        osc.start();
        osc.stop(audioCtx.currentTime + lengthSec + 0.02);
      };

      // Initial 1kHz reference pip, then subtle 1-second pips
      playTick(880, 0.14, 0.14);
      let tickIndex = 1;
      audioTimer = window.setInterval(() => {
        playTick(tickIndex % 4 === 0 ? 880 : 523.25, 0.1, 0.1);
        tickIndex += 1;
      }, 1000);

      combinedTracks.push(...destination.stream.getAudioTracks());
    }
  } catch {
    // Proceed with video-only test clip if audio context is restricted
  }

  const stream = new MediaStream(combinedTracks);
  const caps = detectBrowserCapabilities();
  const mimeType = caps.preferredCodec?.mimeType || 'video/webm';

  const chunks: Blob[] = [];
  const recorder = new MediaRecorder(
    stream,
    mimeType && MediaRecorder.isTypeSupported(mimeType)
      ? { mimeType, videoBitsPerSecond: 3_000_000 }
      : undefined
  );

  recorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  const smpteBars = ['#D4D4D8', '#EAB308', '#06B6D4', '#22C55E', '#D946EF', '#EF4444', '#2563EB'];

  return new Promise((resolve, reject) => {
    let rafId = 0;
    const startTime = performance.now();

    const drawFrame = (now: number) => {
      const elapsed = Math.min(durationMs, now - startTime);
      const progress = elapsed / durationMs;
      onProgress?.(Math.min(99, Math.round(progress * 100)));

      // Background dark broadcast field
      ctx.fillStyle = '#0B0D13';
      ctx.fillRect(0, 0, width, height);

      // Top SMPTE color bar strip
      const barWidth = width / smpteBars.length;
      smpteBars.forEach((color, idx) => {
        ctx.fillStyle = color;
        ctx.fillRect(idx * barWidth, 0, Math.ceil(barWidth), 120);
      });

      // Mid subtle technical grid
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
      ctx.lineWidth = 1;
      for (let x = 0; x <= width; x += 80) {
        ctx.beginPath();
        ctx.moveTo(x, 120);
        ctx.lineTo(x, height);
        ctx.stroke();
      }
      for (let y = 120; y <= height; y += 80) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(width, y);
        ctx.stroke();
      }

      // Sweeping vertical synchronization bar
      const sweepX = progress * width;
      ctx.fillStyle = 'rgba(37, 99, 235, 0.25)';
      ctx.fillRect(sweepX - 24, 120, 48, height - 120);
      ctx.fillStyle = '#3B82F6';
      ctx.fillRect(sweepX - 2, 120, 4, height - 120);

      // Center safe-frame reticle
      ctx.strokeStyle = 'rgba(236, 238, 244, 0.24)';
      ctx.lineWidth = 2;
      ctx.strokeRect(120, 180, width - 240, height - 260);

      // Center broadcast readout
      const sec = Math.floor(elapsed / 1000);
      const ms = Math.floor(elapsed % 1000);
      const frame = Math.floor((elapsed / 1000) * fps);
      const timeLabel = `00:00:${String(sec).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;

      ctx.fillStyle = '#ECEEF4';
      ctx.font = '600 28px "Plus Jakarta Sans", sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('SIGNALDECK BROADCAST TEST CLIP · 1280×720 @ 30FPS', width / 2, 310);

      ctx.fillStyle = '#FFFFFF';
      ctx.font = '600 84px "JetBrains Mono", monospace';
      ctx.fillText(timeLabel, width / 2, 425);

      ctx.fillStyle = '#94A3B8';
      ctx.font = '500 22px "JetBrains Mono", monospace';
      ctx.fillText(
        `FRAME ${String(frame).padStart(4, '0')}   ·   AUDIO SYNC TONE ACTIVE   ·   CLEAN CAPTURE STREAM`,
        width / 2,
        495
      );

      // Bottom progress bar inside video frame
      ctx.fillStyle = '#1E2230';
      ctx.fillRect(200, 560, width - 400, 10);
      ctx.fillStyle = '#2563EB';
      ctx.fillRect(200, 560, (width - 400) * progress, 10);

      if (elapsed < durationMs) {
        rafId = requestAnimationFrame(drawFrame);
      } else if (recorder.state !== 'inactive') {
        recorder.stop();
      }
    };

    recorder.onstop = () => {
      cancelAnimationFrame(rafId);
      if (audioTimer !== null) clearInterval(audioTimer);
      stream.getTracks().forEach((t) => t.stop());
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType });
      onProgress?.(100);
      resolve({
        objectUrl: URL.createObjectURL(blob),
        label: 'Broadcast Test Signal (1280×720 WebM)',
      });
    };

    recorder.onerror = () => {
      cancelAnimationFrame(rafId);
      if (audioTimer !== null) clearInterval(audioTimer);
      stream.getTracks().forEach((t) => t.stop());
      if (audioCtx && audioCtx.state !== 'closed') {
        audioCtx.close().catch(() => {});
      }
      reject(new Error('Failed to generate local broadcast test clip.'));
    };

    recorder.start(250);
    rafId = requestAnimationFrame(drawFrame);
  });
}
