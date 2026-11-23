import type { BrowserCapabilities, CodecProfile, QualityPreset, QualityPresetId } from './types';

export const QUALITY_PRESETS: QualityPreset[] = [
  {
    id: 'auto',
    label: 'Auto',
    bitrateLabel: 'Adaptive',
  },
  {
    id: 'standard',
    label: 'Standard',
    bitrateLabel: '2.5 Mbps',
    videoBitsPerSecond: 2_500_000,
    audioBitsPerSecond: 128_000,
  },
  {
    id: 'high',
    label: 'High',
    bitrateLabel: '5.0 Mbps',
    videoBitsPerSecond: 5_000_000,
    audioBitsPerSecond: 192_000,
  },
  {
    id: 'broadcast',
    label: 'Broadcast',
    bitrateLabel: '8.0 Mbps',
    videoBitsPerSecond: 8_000_000,
    audioBitsPerSecond: 256_000,
  },
];

const CANDIDATE_CODECS: CodecProfile[] = [
  {
    mimeType: 'video/webm;codecs=vp9,opus',
    extension: 'webm',
    label: 'WebM (VP9 + Opus)',
    videoCodec: 'VP9',
    audioCodec: 'Opus',
  },
  {
    mimeType: 'video/webm;codecs=vp8,opus',
    extension: 'webm',
    label: 'WebM (VP8 + Opus)',
    videoCodec: 'VP8',
    audioCodec: 'Opus',
  },
  {
    mimeType: 'video/webm;codecs=h264,opus',
    extension: 'webm',
    label: 'WebM (H.264 + Opus)',
    videoCodec: 'H.264',
    audioCodec: 'Opus',
  },
  {
    mimeType: 'video/webm;codecs=vp9',
    extension: 'webm',
    label: 'WebM (VP9)',
    videoCodec: 'VP9',
    audioCodec: 'Default',
  },
  {
    mimeType: 'video/webm;codecs=vp8',
    extension: 'webm',
    label: 'WebM (VP8)',
    videoCodec: 'VP8',
    audioCodec: 'Default',
  },
  {
    mimeType: 'video/webm',
    extension: 'webm',
    label: 'WebM (Auto)',
    videoCodec: 'Auto',
    audioCodec: 'Auto',
  },
  {
    mimeType: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
    extension: 'mp4',
    label: 'MP4 (H.264 + AAC)',
    videoCodec: 'H.264',
    audioCodec: 'AAC',
  },
  {
    mimeType: 'video/mp4',
    extension: 'mp4',
    label: 'MP4 (Auto)',
    videoCodec: 'Auto',
    audioCodec: 'Auto',
  },
];

interface CaptureCapableVideoElement extends HTMLVideoElement {
  captureStream?: (frameRate?: number) => MediaStream;
  mozCaptureStream?: (frameRate?: number) => MediaStream;
}

/**
 * Probes the current browser for HTMLMediaElement.captureStream() and
 * MediaRecorder.isTypeSupported() codec compatibility.
 */
export function detectBrowserCapabilities(): BrowserCapabilities {
  const hasMediaRecorder = typeof window !== 'undefined' && typeof window.MediaRecorder !== 'undefined';

  let captureMethod: 'captureStream' | 'mozCaptureStream' | 'none' = 'none';
  if (typeof document !== 'undefined') {
    const probeVideo = document.createElement('video') as CaptureCapableVideoElement;
    if (typeof probeVideo.captureStream === 'function') {
      captureMethod = 'captureStream';
    } else if (typeof probeVideo.mozCaptureStream === 'function') {
      captureMethod = 'mozCaptureStream';
    }
  }

  const supportedCodecs: CodecProfile[] = [];
  if (hasMediaRecorder && typeof MediaRecorder.isTypeSupported === 'function') {
    for (const candidate of CANDIDATE_CODECS) {
      try {
        if (MediaRecorder.isTypeSupported(candidate.mimeType)) {
          supportedCodecs.push(candidate);
        }
      } catch {
        // Ignore browser exceptions for exotic MIME probes
      }
    }
  }

  return {
    hasMediaRecorder,
    hasCaptureStream: captureMethod !== 'none',
    captureMethod,
    preferredCodec: supportedCodecs[0] ?? null,
    supportedCodecs,
  };
}

/**
 * Builds MediaRecorderOptions from detected codec and chosen quality preset.
 */
export function buildRecorderOptions(
  codec: CodecProfile | null,
  presetId: QualityPresetId
): MediaRecorderOptions {
  const options: MediaRecorderOptions = {};
  if (codec?.mimeType) {
    options.mimeType = codec.mimeType;
  }

  const preset = QUALITY_PRESETS.find((p) => p.id === presetId);
  if (preset?.videoBitsPerSecond) {
    options.videoBitsPerSecond = preset.videoBitsPerSecond;
  }
  if (preset?.audioBitsPerSecond) {
    options.audioBitsPerSecond = preset.audioBitsPerSecond;
  }

  return options;
}

/**
 * Resolves the clean file extension for a recorded MIME type.
 */
export function getExtensionForMimeType(mimeType: string): string {
  const lower = mimeType.toLowerCase();
  if (lower.includes('mp4')) return 'mp4';
  if (lower.includes('ogg')) return 'ogv';
  return 'webm';
}

/**
 * Generates a meaningful dated filename such as `video-recording-2026-11-23.webm`.
 */
export function buildRecordingFilename(mimeType: string, now: Date = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const ext = getExtensionForMimeType(mimeType);
  return `video-recording-${year}-${month}-${day}.${ext}`;
}

/**
 * Invokes the browser's native media element stream capture method
 * (strictly HTMLMediaElement.captureStream / mozCaptureStream; never screen capture).
 */
export function captureMediaElementStream(video: HTMLVideoElement): MediaStream {
  const captureVideo = video as CaptureCapableVideoElement;
  if (typeof captureVideo.captureStream === 'function') {
    return captureVideo.captureStream();
  }
  if (typeof captureVideo.mozCaptureStream === 'function') {
    return captureVideo.mozCaptureStream();
  }
  throw new Error(
    'This browser does not support HTMLMediaElement.captureStream(). Please use a Chromium-based browser (Chrome, Edge, Brave) or Firefox.'
  );
}
