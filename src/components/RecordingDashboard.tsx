import {
  AlertCircle,
  CheckCircle2,
  Circle,
  Download,
  Loader2,
  OctagonX,
  Pause,
  Play,
  Square,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { QUALITY_PRESETS } from '../engine/codecDetector';
import { formatBroadcastTimecode, formatFileSize } from '../engine/fileDownloader';
import type {
  QualityPresetId,
  RecorderStatus,
  RecordingSessionState,
} from '../engine/types';

interface RecordingDashboardProps {
  recording: RecordingSessionState;
  isVideoLoaded: boolean;
  hasVideoSource: boolean;
  onStartRecording: () => void;
  onPauseRecording: () => void;
  onResumeRecording: () => void;
  onStopRecording: () => void;
  onStopVideo: () => void;
  onDownloadFinal: () => void;
  onSelectQuality: (preset: QualityPresetId) => void;
}

const STATUS_META: Record<
  RecorderStatus,
  {
    label: string;
    toneClass: string;
  }
> = {
  ready: {
    label: 'Ready',
    toneClass: 'text-[#111318] dark:text-[#ECEEF4]',
  },
  loading: {
    label: 'Loading Video',
    toneClass: 'text-[#2563EB] dark:text-[#60A5FA]',
  },
  recording: {
    label: 'Recording',
    toneClass: 'text-[#DC2626] dark:text-[#F87171]',
  },
  paused: {
    label: 'Recording Paused',
    toneClass: 'text-[#D97706] dark:text-[#FBBF24]',
  },
  buffering: {
    label: 'Buffering',
    toneClass: 'text-[#D97706] dark:text-[#FBBF24]',
  },
  offline: {
    label: 'Network Disconnected',
    toneClass: 'text-[#DC2626] dark:text-[#F87171]',
  },
  completed: {
    label: 'Recording Completed',
    toneClass: 'text-[#16A34A] dark:text-[#4ADE80]',
  },
  'download-ready': {
    label: 'Download Ready',
    toneClass: 'text-[#16A34A] dark:text-[#4ADE80]',
  },
};

export function RecordingDashboard({
  recording,
  isVideoLoaded,
  hasVideoSource,
  onStartRecording,
  onPauseRecording,
  onResumeRecording,
  onStopRecording,
  onStopVideo,
  onDownloadFinal,
  onSelectQuality,
}: RecordingDashboardProps) {
  const statusInfo = STATUS_META[recording.status];

  const canStart = isVideoLoaded && !recording.isRecordingActive;
  const canPause = recording.isRecordingActive && !recording.isPaused;
  const canResume = recording.isRecordingActive && recording.isPaused;
  const canStopRecording = recording.isRecordingActive;
  const canStopVideo = hasVideoSource || recording.isRecordingActive;
  const canDownload = Boolean(recording.finalized) && !recording.isRecordingActive;

  return (
    <aside
      aria-label="Recording Control Dashboard"
      className="flex h-full flex-col justify-between border border-[#E1E4EC] bg-white dark:border-[#252936] dark:bg-[#12141C]"
    >
      <div>
        {/* Status Header */}
        <div className="border-b border-[#E8EBF1] px-5 py-4 dark:border-[#1F2330]">
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-[#5A6174] dark:text-[#8E95A8]">
              Session Status
            </span>
            <div className="flex items-center gap-1.5 font-mono text-xs text-[#5A6174] dark:text-[#8E95A8]">
              {recording.isOnline ? (
                <>
                  <Wifi className="h-3.5 w-3.5 text-[#16A34A] dark:text-emerald-400" aria-hidden="true" />
                  <span>Online</span>
                </>
              ) : (
                <>
                  <WifiOff className="h-3.5 w-3.5 text-[#DC2626] dark:text-red-400" aria-hidden="true" />
                  <span className="text-[#DC2626] dark:text-red-400">Offline</span>
                </>
              )}
            </div>
          </div>

          <div className={`mt-2 flex items-center gap-2.5 font-display text-lg font-bold ${statusInfo.toneClass}`}>
            {recording.status === 'recording' && (
              <span
                className="h-2.5 w-2.5 shrink-0 animate-pulse rounded-full bg-[#DC2626]"
                aria-hidden="true"
              />
            )}
            {recording.status === 'loading' || recording.status === 'buffering' ? (
              <Loader2 className="h-4.5 w-4.5 shrink-0 animate-spin" aria-hidden="true" />
            ) : null}
            {recording.status === 'offline' ? (
              <WifiOff className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
            ) : null}
            {recording.status === 'paused' ? (
              <Pause className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
            ) : null}
            {recording.status === 'completed' || recording.status === 'download-ready' ? (
              <CheckCircle2 className="h-4.5 w-4.5 shrink-0" aria-hidden="true" />
            ) : null}
            <span>{statusInfo.label}</span>
          </div>

          <p className="mt-1.5 text-xs leading-relaxed text-[#5A6174] dark:text-[#8E95A8]">
            {recording.statusMessage}
          </p>
        </div>

        {/* Precision Broadcast Timecode Readout */}
        <div className="border-b border-[#E8EBF1] bg-[#F8F9FB] px-5 py-5 dark:border-[#1F2330] dark:bg-[#0C0E14]">
          <div className="flex items-baseline justify-between">
            <span className="text-xs font-medium text-[#5A6174] dark:text-[#8E95A8]">
              Elapsed Recording Time
            </span>
            <span className="font-mono text-xs text-[#6B7285] tabular-nums dark:text-[#7E869B]">
              HH:MM:SS.d
            </span>
          </div>
          <div
            aria-live="off"
            className="mt-2 font-mono text-4xl font-semibold tracking-tight text-[#111318] tabular-nums dark:text-white"
          >
            {formatBroadcastTimecode(recording.elapsedMs)}
          </div>

          {/* Unboxed real-time session telemetry */}
          <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-[#5A6174] tabular-nums dark:text-[#8E95A8]">
            <span>{recording.chunkCount} chunks</span>
            <span aria-hidden="true">·</span>
            <span>{formatFileSize(recording.recordedBytes)}</span>
            <span aria-hidden="true">·</span>
            <span className="truncate max-w-[180px]" title={recording.activeMimeType}>
              {recording.activeMimeType}
            </span>
          </div>
        </div>

        {/* Inline Recording Error Banner */}
        {recording.errorMessage && (
          <div
            role="alert"
            className="flex items-start gap-2.5 border-b border-red-200 bg-red-50 px-5 py-3 text-xs text-red-900 dark:border-red-900/50 dark:bg-red-950/35 dark:text-red-200"
          >
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626] dark:text-red-400" aria-hidden="true" />
            <span className="leading-relaxed">{recording.errorMessage}</span>
          </div>
        )}

        {/* Quality Preset Selector */}
        <div className="border-b border-[#E8EBF1] px-5 py-4 dark:border-[#1F2330]">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[#5A6174] dark:text-[#8E95A8]">
              Recording Bitrate Preset
            </span>
            <span className="font-mono text-xs text-[#6B7285] tabular-nums dark:text-[#7E869B]">
              {QUALITY_PRESETS.find((p) => p.id === recording.qualityPreset)?.bitrateLabel}
            </span>
          </div>
          <div
            role="radiogroup"
            aria-label="Recording quality preset"
            className="mt-2.5 grid grid-cols-4 gap-1 rounded-md bg-[#F0F2F6] p-1 dark:bg-[#0B0D13]"
          >
            {QUALITY_PRESETS.map((preset) => {
              const active = recording.qualityPreset === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  disabled={recording.isRecordingActive}
                  onClick={() => onSelectQuality(preset.id)}
                  className={`h-8 cursor-pointer truncate rounded px-2 text-xs font-medium whitespace-nowrap transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-50 ${
                    active
                      ? 'bg-white text-[#111318] shadow-xs dark:bg-[#1E2332] dark:text-[#ECEEF4]'
                      : 'text-[#5A6174] hover:text-[#111318] dark:text-[#8E95A8] dark:hover:text-[#ECEEF4]'
                  }`}
                >
                  {preset.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Dedicated Recording Controls */}
        <div className="space-y-2.5 px-5 py-5">
          {/* Primary Start Action */}
          <button
            type="button"
            onClick={onStartRecording}
            disabled={!canStart}
            className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[#DC2626] px-4 text-sm font-semibold text-white transition-colors duration-150 hover:bg-[#B91C1C] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#DC2626] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <Circle className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
            <span>Start Recording</span>
          </button>

          {/* Pause & Resume Pair */}
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={onPauseRecording}
              disabled={!canPause}
              className="inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[#D4D8E2] bg-white px-3 text-xs font-semibold text-[#111318] transition-colors duration-150 hover:bg-[#F2F4F8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#2A2F3E] dark:bg-[#171A25] dark:text-[#ECEEF4] dark:hover:bg-[#202433]"
            >
              <Pause className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Pause Recording</span>
            </button>

            <button
              type="button"
              onClick={onResumeRecording}
              disabled={!canResume}
              className="inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[#D4D8E2] bg-white px-3 text-xs font-semibold text-[#111318] transition-colors duration-150 hover:bg-[#F2F4F8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#2A2F3E] dark:bg-[#171A25] dark:text-[#ECEEF4] dark:hover:bg-[#202433]"
            >
              <Play className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Resume Recording</span>
            </button>
          </div>

          {/* Separate Stop Recording vs Stop Video Pair */}
          <div className="grid grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={onStopRecording}
              disabled={!canStopRecording}
              title="Stops recording and finalizes chunks without stopping video playback"
              className="inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[#D4D8E2] bg-[#F8F9FB] px-3 text-xs font-semibold text-[#111318] transition-colors duration-150 hover:bg-[#EAECEF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-40 dark:border-[#2A2F3E] dark:bg-[#1B1F2C] dark:text-[#ECEEF4] dark:hover:bg-[#242A3B]"
            >
              <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
              <span>Stop Recording</span>
            </button>

            <button
              type="button"
              onClick={onStopVideo}
              disabled={!canStopVideo}
              title="Stops video playback and active recording together, preserving and finalizing all recorded chunks"
              className="inline-flex h-10 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-red-300 bg-red-50 px-3 text-xs font-semibold text-[#B91C1C] transition-colors duration-150 hover:bg-red-100 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#DC2626] disabled:cursor-not-allowed disabled:opacity-40 dark:border-red-900/60 dark:bg-red-950/35 dark:text-red-300 dark:hover:bg-red-950/55"
            >
              <OctagonX className="h-3.5 w-3.5" aria-hidden="true" />
              <span>Stop Video</span>
            </button>
          </div>
        </div>
      </div>

      {/* Dedicated Download Final Video Footer Zone */}
      <div className="border-t border-[#E8EBF1] bg-[#F8F9FB] px-5 py-4 dark:border-[#1F2330] dark:bg-[#0D1017]">
        <button
          type="button"
          onClick={onDownloadFinal}
          disabled={!canDownload}
          className="inline-flex h-11 w-full cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[#2563EB] px-4 text-sm font-semibold text-white transition-colors duration-150 hover:bg-[#1D4ED8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:bg-[#94A3B8] disabled:opacity-55 dark:disabled:bg-[#2A3042]"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          <span>Download Final Video</span>
        </button>
        <p className="mt-2 text-center text-xs text-[#5A6174] dark:text-[#8E95A8]">
          {canDownload && recording.finalized
            ? `Ready: ${recording.finalized.filename} (${formatFileSize(recording.finalized.sizeBytes)})`
            : 'Enabled automatically once recording is finalized.'}
        </p>
      </div>
    </aside>
  );
}
