import { buildRecordingFilename, getExtensionForMimeType } from './codecDetector';
import type { FinalizedRecording } from './types';

/**
 * Combines all accumulated recording chunks into a single Blob and
 * constructs a finalized download artifact with an active Object URL.
 */
export function assembleFinalRecording(params: {
  chunks: Blob[];
  mimeType: string;
  durationMs: number;
  width: number;
  height: number;
  endedReason: FinalizedRecording['endedReason'];
}): FinalizedRecording {
  const effectiveMime = params.mimeType || params.chunks[0]?.type || 'video/webm';
  const blob = new Blob(params.chunks, { type: effectiveMime });
  const objectUrl = URL.createObjectURL(blob);
  const createdAt = new Date();

  return {
    blob,
    objectUrl,
    filename: buildRecordingFilename(effectiveMime, createdAt),
    mimeType: effectiveMime,
    extension: getExtensionForMimeType(effectiveMime),
    durationMs: params.durationMs,
    sizeBytes: blob.size,
    width: params.width,
    height: params.height,
    chunkCount: params.chunks.length,
    endedReason: params.endedReason,
    createdAt,
  };
}

/**
 * Safely triggers a local browser file download for a finalized recording.
 */
export function triggerRecordingDownload(recording: FinalizedRecording): void {
  if (!recording.blob || recording.blob.size === 0 || !recording.objectUrl) {
    throw new Error('Cannot download an empty or unfinalized recording.');
  }

  const anchor = document.createElement('a');
  anchor.href = recording.objectUrl;
  anchor.download = recording.filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
}

/**
 * Releases a previously created Object URL to avoid memory leaks.
 */
export function revokeObjectUrlSafe(url: string | null | undefined): void {
  if (url && url.startsWith('blob:')) {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // Ignore already revoked URLs
    }
  }
}

/**
 * Formats milliseconds into crisp broadcast timecode `HH:MM:SS.d`.
 */
export function formatBroadcastTimecode(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const tenths = Math.floor((safeMs % 1000) / 100);

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths}`;
}

/**
 * Formats seconds into playback timestamp `MM:SS` or `HH:MM:SS`.
 */
export function formatPlaybackTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;

  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/**
 * Formats raw byte sizes into clean units (B, KB, MB, GB).
 */
export function formatFileSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 100 || unitIndex === 0 ? value.toFixed(0) : value.toFixed(2)} ${units[unitIndex]}`;
}
