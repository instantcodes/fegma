/**
 * Core types for SignalDeck's modular HTML5 video capture & MediaRecorder engine.
 */

export type RecorderStatus =
  | 'ready'
  | 'loading'
  | 'recording'
  | 'paused'
  | 'buffering'
  | 'offline'
  | 'completed'
  | 'download-ready';

export type PauseReason = 'none' | 'manual' | 'buffering' | 'offline' | 'video-paused';

export type QualityPresetId = 'auto' | 'standard' | 'high' | 'broadcast';

export interface QualityPreset {
  id: QualityPresetId;
  label: string;
  bitrateLabel: string;
  videoBitsPerSecond?: number;
  audioBitsPerSecond?: number;
}

export interface CodecProfile {
  mimeType: string;
  extension: string;
  label: string;
  videoCodec: string;
  audioCodec: string;
}

export interface BrowserCapabilities {
  hasMediaRecorder: boolean;
  hasCaptureStream: boolean;
  captureMethod: 'captureStream' | 'mozCaptureStream' | 'none';
  preferredCodec: CodecProfile | null;
  supportedCodecs: CodecProfile[];
}

export type VideoSourceType = 'url' | 'sample' | 'synthetic' | 'file';

export interface SampleVideoItem {
  id: string;
  title: string;
  description: string;
  durationHint: string;
  url: string;
  type: 'sample' | 'synthetic';
}

export interface VideoPlaybackState {
  sourceUrl: string;
  sourceLabel: string;
  sourceType: VideoSourceType | null;
  viaProxy: boolean;
  isLoaded: boolean;
  isPlaying: boolean;
  isMuted: boolean;
  loadProgress: number; // 0 to 100
  bufferedPercent: number; // 0 to 100
  currentTime: number;
  duration: number;
  videoWidth: number;
  videoHeight: number;
  hasAudioTrack: boolean | null;
  errorMessage: string | null;
}

export interface FinalizedRecording {
  blob: Blob;
  objectUrl: string;
  filename: string;
  mimeType: string;
  extension: string;
  durationMs: number;
  sizeBytes: number;
  width: number;
  height: number;
  chunkCount: number;
  endedReason: 'natural-end' | 'stop-recording' | 'stop-video';
  createdAt: Date;
}

export interface RecordingSessionState {
  status: RecorderStatus;
  pauseReason: PauseReason;
  isOnline: boolean;
  isRecordingActive: boolean; // true while MediaRecorder is 'recording' or 'paused'
  isPaused: boolean;
  elapsedMs: number;
  chunkCount: number;
  recordedBytes: number;
  activeMimeType: string;
  qualityPreset: QualityPresetId;
  statusMessage: string;
  errorMessage: string | null;
  finalized: FinalizedRecording | null;
}

export interface EngineSnapshot {
  video: VideoPlaybackState;
  recording: RecordingSessionState;
}
