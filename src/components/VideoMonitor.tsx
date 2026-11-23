import { AlertTriangle, MonitorPlay, Pause, Play, Volume2, VolumeX } from 'lucide-react';
import type { RefObject } from 'react';
import { formatPlaybackTime } from '../engine/fileDownloader';
import type { RecorderStatus, VideoPlaybackState } from '../engine/types';

interface VideoMonitorProps {
  videoRef: RefObject<HTMLVideoElement | null>;
  videoState: VideoPlaybackState;
  recorderStatus: RecorderStatus;
  isRecordingActive: boolean;
  onTogglePlayPause: () => void;
  onSeek: (seconds: number) => void;
}

export function VideoMonitor({
  videoRef,
  videoState,
  recorderStatus,
  isRecordingActive,
  onTogglePlayPause,
  onSeek,
}: VideoMonitorProps) {
  const playbackPercent =
    videoState.duration > 0
      ? Math.min(100, (videoState.currentTime / videoState.duration) * 100)
      : 0;

  const isLoading = recorderStatus === 'loading';
  const showEmptyPlaceholder = !videoState.sourceUrl && !videoState.errorMessage;

  return (
    <div className="flex h-full flex-col justify-between border border-[#E1E4EC] bg-white dark:border-[#252936] dark:bg-[#12141C]">
      {/* Monitor header strip */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E8EBF1] px-5 py-3 dark:border-[#1F2330]">
        <div className="min-w-0 flex-1">
          <h2 className="font-display text-sm font-semibold text-[#111318] dark:text-[#ECEEF4]">
            Program Monitor
          </h2>
          <p className="mt-0.5 truncate text-xs text-[#5A6174] dark:text-[#8E95A8]">
            {videoState.sourceLabel || 'No video source loaded'}
          </p>
        </div>

        {/* Clean unboxed technical metadata */}
        <div className="flex shrink-0 items-center gap-2 font-mono text-xs text-[#5A6174] tabular-nums dark:text-[#8E95A8]">
          <span>
            {videoState.videoWidth > 0 && videoState.videoHeight > 0
              ? `${videoState.videoWidth}×${videoState.videoHeight}`
              : '— × —'}
          </span>
          <span aria-hidden="true">·</span>
          <span>Cursor Excluded</span>
          {videoState.isLoaded && (
            <>
              <span aria-hidden="true">·</span>
              <span className="inline-flex items-center gap-1">
                {videoState.isMuted ? (
                  <>
                    <VolumeX className="h-3.5 w-3.5 text-amber-500" aria-hidden="true" />
                    <span className="text-amber-600 dark:text-amber-400">Muted</span>
                  </>
                ) : (
                  <>
                    <Volume2 className="h-3.5 w-3.5 text-[#16A34A] dark:text-emerald-400" aria-hidden="true" />
                    <span>Audio Live</span>
                  </>
                )}
              </span>
            </>
          )}
        </div>
      </div>

      {/* Main 16:9 HTML5 Video Canvas */}
      <div className="relative aspect-video w-full overflow-hidden bg-[#07080C]">
        <video
          ref={videoRef}
          controls
          playsInline
          preload="auto"
          className={`h-full w-full object-contain ${showEmptyPlaceholder ? 'opacity-0' : 'opacity-100'}`}
        />

        {/* Clean studio empty state */}
        {showEmptyPlaceholder && (
          <div className="absolute inset-0 flex flex-col items-center justify-center px-6 text-center">
            <MonitorPlay className="h-11 w-11 text-[#434A5E]" aria-hidden="true" />
            <p className="mt-3.5 font-display text-base font-semibold text-[#E5E8F0]">
              Ready for Direct Video Stream
            </p>
            <p className="mt-1.5 max-w-md text-sm leading-relaxed text-[#8E95A8]">
              Paste a direct video URL above, select a sample clip, or load a local file. SignalDeck
              captures the decoded stream directly from this player—never your screen or cursor.
            </p>
          </div>
        )}

        {/* Loading Progress Overlay */}
        {isLoading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/75 px-8 text-center backdrop-blur-[2px]">
            <p className="font-display text-sm font-semibold text-white">Loading Video Stream</p>
            <div className="mt-3 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/15">
              <div
                className="h-full bg-[#2563EB] transition-all duration-200"
                style={{ width: `${Math.max(8, videoState.loadProgress)}%` }}
              />
            </div>
            <p className="mt-2 font-mono text-xs text-zinc-300 tabular-nums">
              {videoState.loadProgress}% buffered
            </p>
          </div>
        )}

        {/* Active Recording Tally Overlay (strictly when live recording) */}
        {isRecordingActive && (
          <div className="pointer-events-none absolute top-3.5 left-3.5 flex items-center gap-2 rounded bg-black/75 px-2.5 py-1 font-mono text-xs font-medium text-white backdrop-blur-xs">
            <span
              className={`h-2 w-2 rounded-full ${
                recorderStatus === 'recording'
                  ? 'animate-pulse bg-[#DC2626]'
                  : 'bg-[#D97706]'
              }`}
              aria-hidden="true"
            />
            <span>
              {recorderStatus === 'recording'
                ? 'REC'
                : recorderStatus === 'offline'
                  ? 'OFFLINE · PAUSED'
                  : recorderStatus === 'buffering'
                    ? 'BUFFERING · PAUSED'
                    : 'PAUSED'}
            </span>
          </div>
        )}
      </div>

      {/* Inline Media / CORS Error Banner */}
      {videoState.errorMessage && (
        <div
          role="alert"
          className="flex items-start gap-3 border-t border-red-200 bg-red-50 px-5 py-3.5 text-sm text-red-900 dark:border-red-900/50 dark:bg-red-950/35 dark:text-red-200"
        >
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[#DC2626] dark:text-red-400" aria-hidden="true" />
          <div className="min-w-0">
            <p className="font-semibold">Unable to Load Video Source</p>
            <p className="mt-0.5 text-xs leading-relaxed opacity-90">{videoState.errorMessage}</p>
          </div>
        </div>
      )}

      {/* Custom Studio Transport & Progress Readout */}
      <div className="border-t border-[#E8EBF1] px-5 py-4 dark:border-[#1F2330]">
        {/* Buffered + Playback Track */}
        <div className="relative flex items-center">
          <div className="pointer-events-none absolute inset-x-0 h-1.5 overflow-hidden rounded-full bg-[#E4E7EF] dark:bg-[#232735]">
            {/* Buffered progress bar */}
            <div
              className="absolute inset-y-0 left-0 bg-[#CBD2E1] transition-all duration-200 dark:bg-[#3A4157]"
              style={{ width: `${videoState.bufferedPercent}%` }}
            />
            {/* Active playback progress bar */}
            <div
              className="absolute inset-y-0 left-0 bg-[#2563EB]"
              style={{ width: `${playbackPercent}%` }}
            />
          </div>
          <input
            type="range"
            aria-label="Playback position"
            min={0}
            max={videoState.duration || 0}
            step={0.1}
            value={Math.min(videoState.currentTime, videoState.duration || 0)}
            disabled={!videoState.isLoaded || videoState.duration <= 0}
            onChange={(e) => onSeek(parseFloat(e.target.value))}
            className="studio-scrubber relative z-10 h-5 w-full disabled:cursor-not-allowed disabled:opacity-50"
          />
        </div>

        {/* Timecode & Transport Summary */}
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onTogglePlayPause}
              disabled={!videoState.isLoaded}
              className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md border border-[#D4D8E2] bg-[#F8F9FB] px-3 text-xs font-medium text-[#111318] transition-colors hover:bg-[#ECEEF3] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-45 dark:border-[#2A2F3E] dark:bg-[#171A25] dark:text-[#ECEEF4] dark:hover:bg-[#212636]"
            >
              {videoState.isPlaying ? (
                <>
                  <Pause className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Pause Player</span>
                </>
              ) : (
                <>
                  <Play className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Play Player</span>
                </>
              )}
            </button>

            <div className="font-mono text-sm font-medium text-[#111318] tabular-nums dark:text-[#ECEEF4]">
              <span>{formatPlaybackTime(videoState.currentTime)}</span>
              <span className="mx-1.5 text-[#7E869B]">/</span>
              <span className="text-[#5A6174] dark:text-[#8E95A8]">
                {formatPlaybackTime(videoState.duration)}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2 font-mono text-xs text-[#5A6174] tabular-nums dark:text-[#8E95A8]">
            <span>Played {Math.round(playbackPercent)}%</span>
            <span aria-hidden="true">·</span>
            <span>Buffered {videoState.bufferedPercent}%</span>
          </div>
        </div>

        {isRecordingActive && videoState.isMuted && (
          <p className="mt-2.5 text-xs text-amber-700 dark:text-amber-400">
            Note: Player audio is currently muted. Unmute the video player to capture its audio track.
          </p>
        )}
      </div>
    </div>
  );
}
