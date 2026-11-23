import Hls from 'hls.js';
import {
  buildRecorderOptions,
  captureMediaElementStream,
  detectBrowserCapabilities,
} from './codecDetector';
import {
  assembleFinalRecording,
  revokeObjectUrlSafe,
  triggerRecordingDownload,
} from './fileDownloader';
import type {
  BrowserCapabilities,
  EngineSnapshot,
  FinalizedRecording,
  PauseReason,
  QualityPresetId,
  RecorderStatus,
  VideoSourceType,
} from './types';
import {
  buildSameOriginProxyUrl,
  classifyVideoLoadError,
  isLikelyEmbedPageUrl,
  isLikelyHlsUrl,
  resolveRemoteVideoUrl,
  validateVideoUrl,
} from './videoLoader';

type SnapshotListener = (snapshot: EngineSnapshot) => void;

/**
 * Framework-agnostic Vanilla TypeScript controller encapsulating:
 * - Video loading & playback telemetry
 * - HTMLMediaElement.captureStream() + MediaRecorder lifecycle
 * - Manual pause/resume & chunk preservation
 * - Network disconnection & buffering auto-pause/auto-resume
 * - Automatic video-end termination
 * - Separate Stop Recording vs Stop Video controls
 * - Final Blob assembly & local downloading
 */
export class VideoRecordingEngine {
  private video: HTMLVideoElement | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private capturedStream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private listeners = new Set<SnapshotListener>();

  private capabilities: BrowserCapabilities = detectBrowserCapabilities();
  private snapshot: EngineSnapshot;

  // Source blob, HLS, & proxy fallback tracking
  private activeOwnedSourceBlobUrl: string | null = null;
  private hlsInstance: Hls | null = null;
  private loadSequenceId = 0;
  private hasTriedProxyFallback = false;

  // Accurate elapsed recording timer (excludes paused / buffering / offline intervals)
  private accumulatedElapsedMs = 0;
  private activeSegmentStartMs: number | null = null;
  private timerIntervalId: number | null = null;

  // Stall watchdog for networks where stalled/waiting events lag behind reality
  private watchdogIntervalId: number | null = null;
  private lastObservedVideoTime = -1;
  private stagnantTicks = 0;

  // Finalization metadata
  private pendingEndReason: FinalizedRecording['endedReason'] = 'stop-recording';
  private isStoppingRecorder = false;

  constructor() {
    const online = typeof navigator !== 'undefined' ? navigator.onLine : true;
    this.snapshot = {
      video: {
        sourceUrl: '',
        sourceLabel: '',
        sourceType: null,
        viaProxy: false,
        isLoaded: false,
        isPlaying: false,
        isMuted: false,
        loadProgress: 0,
        bufferedPercent: 0,
        currentTime: 0,
        duration: 0,
        videoWidth: 0,
        videoHeight: 0,
        hasAudioTrack: null,
        errorMessage: null,
      },
      recording: {
        status: online ? 'ready' : 'offline',
        pauseReason: 'none',
        isOnline: online,
        isRecordingActive: false,
        isPaused: false,
        elapsedMs: 0,
        chunkCount: 0,
        recordedBytes: 0,
        activeMimeType: this.capabilities.preferredCodec?.mimeType ?? 'video/webm',
        qualityPreset: 'auto',
        statusMessage: online
          ? 'Load a direct video URL, sample clip, or local file to begin.'
          : 'Network is offline. Reconnect or load a local video file.',
        errorMessage: null,
        finalized: null,
      },
    };
  }

  public getCapabilities(): BrowserCapabilities {
    return this.capabilities;
  }

  public getSnapshot(): EngineSnapshot {
    return this.snapshot;
  }

  public subscribe(listener: SnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.snapshot);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const next: EngineSnapshot = {
      video: { ...this.snapshot.video },
      recording: { ...this.snapshot.recording },
    };
    this.snapshot = next;
    for (const listener of this.listeners) {
      listener(next);
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle & Event Binding
  // ---------------------------------------------------------------------------

  public attachVideoElement(videoEl: HTMLVideoElement): void {
    if (this.video === videoEl) return;
    this.detachVideoElement();
    this.video = videoEl;

    videoEl.addEventListener('loadstart', this.onVideoLoadStart);
    videoEl.addEventListener('progress', this.onVideoProgress);
    videoEl.addEventListener('loadedmetadata', this.onVideoLoadedMetadata);
    videoEl.addEventListener('loadeddata', this.onVideoLoadedData);
    videoEl.addEventListener('canplay', this.onVideoCanPlay);
    videoEl.addEventListener('play', this.onVideoPlay);
    videoEl.addEventListener('playing', this.onVideoPlaying);
    videoEl.addEventListener('pause', this.onVideoPause);
    videoEl.addEventListener('waiting', this.onVideoWaiting);
    videoEl.addEventListener('stalled', this.onVideoStalled);
    videoEl.addEventListener('timeupdate', this.onVideoTimeUpdate);
    videoEl.addEventListener('volumechange', this.onVideoVolumeChange);
    videoEl.addEventListener('ended', this.onVideoEnded);
    videoEl.addEventListener('error', this.onVideoError);

    window.addEventListener('online', this.onWindowOnline);
    window.addEventListener('offline', this.onWindowOffline);
  }

  public detachVideoElement(): void {
    if (this.video) {
      this.video.removeEventListener('loadstart', this.onVideoLoadStart);
      this.video.removeEventListener('progress', this.onVideoProgress);
      this.video.removeEventListener('loadedmetadata', this.onVideoLoadedMetadata);
      this.video.removeEventListener('loadeddata', this.onVideoLoadedData);
      this.video.removeEventListener('canplay', this.onVideoCanPlay);
      this.video.removeEventListener('play', this.onVideoPlay);
      this.video.removeEventListener('playing', this.onVideoPlaying);
      this.video.removeEventListener('pause', this.onVideoPause);
      this.video.removeEventListener('waiting', this.onVideoWaiting);
      this.video.removeEventListener('stalled', this.onVideoStalled);
      this.video.removeEventListener('timeupdate', this.onVideoTimeUpdate);
      this.video.removeEventListener('volumechange', this.onVideoVolumeChange);
      this.video.removeEventListener('ended', this.onVideoEnded);
      this.video.removeEventListener('error', this.onVideoError);
      this.video = null;
    }
    window.removeEventListener('online', this.onWindowOnline);
    window.removeEventListener('offline', this.onWindowOffline);
    this.stopTimers();
  }

  private destroyHlsInstance(): void {
    if (this.hlsInstance) {
      try {
        this.hlsInstance.destroy();
      } catch {
        // Ignore teardown errors
      }
      this.hlsInstance = null;
    }
  }

  public destroy(): void {
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      try {
        this.mediaRecorder.stop();
      } catch {
        // Ignore teardown errors
      }
    }
    this.destroyHlsInstance();
    this.detachVideoElement();
    revokeObjectUrlSafe(this.activeOwnedSourceBlobUrl);
    revokeObjectUrlSafe(this.snapshot.recording.finalized?.objectUrl);
  }

  // ---------------------------------------------------------------------------
  // Video Loading & Playback Logic
  // ---------------------------------------------------------------------------

  public setQualityPreset(preset: QualityPresetId): void {
    if (this.snapshot.recording.isRecordingActive) return;
    this.snapshot.recording.qualityPreset = preset;
    this.emit();
  }

  public setVideoError(message: string): void {
    this.snapshot.video.errorMessage = message;
    this.emit();
  }

  public loadDirectUrl(rawUrl: string, label?: string, sourceType: VideoSourceType = 'url'): boolean {
    if (!this.video) return false;

    if (this.snapshot.recording.isRecordingActive) {
      this.snapshot.recording.errorMessage =
        'Stop the active recording before loading a different video source.';
      this.emit();
      return false;
    }

    const validation = validateVideoUrl(rawUrl);
    if (!validation.valid) {
      this.snapshot.video.errorMessage = validation.error ?? 'Invalid video URL.';
      this.emit();
      return false;
    }

    // Revoke previously owned local/synthetic blob URL if replacing
    if (this.activeOwnedSourceBlobUrl && this.activeOwnedSourceBlobUrl !== validation.normalizedUrl) {
      revokeObjectUrlSafe(this.activeOwnedSourceBlobUrl);
      this.activeOwnedSourceBlobUrl = null;
    }

    const isRemote =
      validation.normalizedUrl.startsWith('http://') ||
      validation.normalizedUrl.startsWith('https://');

    this.loadSequenceId += 1;
    this.hasTriedProxyFallback = false;
    this.destroyHlsInstance();

    this.video.pause();
    this.video.removeAttribute('src');

    // Enforce anonymous CORS for remote URLs so HTMLMediaElement.captureStream() is permitted
    if (isRemote) {
      this.video.crossOrigin = 'anonymous';
    } else {
      this.video.removeAttribute('crossorigin');
    }

    this.snapshot.video = {
      ...this.snapshot.video,
      sourceUrl: validation.normalizedUrl,
      sourceLabel: label || validation.normalizedUrl,
      sourceType,
      viaProxy: false,
      isLoaded: false,
      isPlaying: false,
      loadProgress: 5,
      bufferedPercent: 0,
      currentTime: 0,
      duration: 0,
      videoWidth: 0,
      videoHeight: 0,
      hasAudioTrack: null,
      errorMessage: null,
    };

    this.snapshot.recording = {
      ...this.snapshot.recording,
      status: 'loading',
      statusMessage: 'Loading video metadata and initial buffer…',
      errorMessage: null,
    };
    this.emit();

    // Fast-path embed player URLs (e.g. Bunny Stream iframe.mediadelivery.net) and HLS .m3u8 streams
    if (isRemote && (isLikelyEmbedPageUrl(validation.normalizedUrl) || isLikelyHlsUrl(validation.normalizedUrl))) {
      this.hasTriedProxyFallback = true;
      this.snapshot.video.loadProgress = 15;
      this.snapshot.recording.statusMessage =
        'Resolving embedded video stream through same-origin media proxy…';
      this.emit();
      void this.attemptSameOriginProxyFallback(validation.normalizedUrl, this.loadSequenceId);
      return true;
    }

    this.video.src = validation.normalizedUrl;
    this.video.load();
    return true;
  }

  public loadBlobSource(objectUrl: string, label: string, sourceType: 'file' | 'synthetic'): boolean {
    if (!this.video) return false;

    if (this.snapshot.recording.isRecordingActive) {
      this.snapshot.recording.errorMessage =
        'Stop the active recording before loading a different video source.';
      this.emit();
      return false;
    }

    if (this.activeOwnedSourceBlobUrl && this.activeOwnedSourceBlobUrl !== objectUrl) {
      revokeObjectUrlSafe(this.activeOwnedSourceBlobUrl);
    }
    this.activeOwnedSourceBlobUrl = objectUrl;

    return this.loadDirectUrl(objectUrl, label, sourceType);
  }

  public seekTo(seconds: number): void {
    if (!this.video || !Number.isFinite(seconds)) return;
    const clamped = Math.max(0, Math.min(seconds, this.video.duration || 0));
    this.video.currentTime = clamped;
    this.snapshot.video.currentTime = clamped;
    this.emit();
  }

  public togglePlayPause(): void {
    if (!this.video || !this.snapshot.video.isLoaded) return;
    if (this.video.paused || this.video.ended) {
      if (this.video.ended) {
        this.video.currentTime = 0;
      }
      this.video.play().catch((err: unknown) => {
        this.snapshot.video.errorMessage =
          err instanceof Error ? err.message : 'Playback was blocked by the browser.';
        this.emit();
      });
    } else {
      this.video.pause();
    }
  }

  // ---------------------------------------------------------------------------
  // Recording Initialization & Controls
  // ---------------------------------------------------------------------------

  public async startRecording(): Promise<void> {
    if (!this.video) return;

    if (!this.capabilities.hasMediaRecorder) {
      this.snapshot.recording.errorMessage =
        'MediaRecorder API is not supported in this browser.';
      this.emit();
      return;
    }

    if (!this.capabilities.hasCaptureStream) {
      this.snapshot.recording.errorMessage =
        'HTMLMediaElement.captureStream() is not supported in this browser. Screen recording is intentionally disabled.';
      this.emit();
      return;
    }

    if (!this.snapshot.video.isLoaded || this.video.readyState < 1) {
      this.snapshot.recording.errorMessage = 'Load a compatible video before starting a recording.';
      this.emit();
      return;
    }

    if (this.snapshot.recording.isRecordingActive) {
      return;
    }

    this.snapshot.recording.errorMessage = null;

    // Reset to start if video was already at the end
    if (this.video.ended) {
      this.video.currentTime = 0;
    }

    // Start playback first so captureStream() populates active video & audio tracks
    if (this.video.paused) {
      try {
        await this.video.play();
      } catch (err: unknown) {
        this.snapshot.recording.errorMessage =
          err instanceof Error
            ? `Could not start video playback for recording: ${err.message}`
            : 'Could not start video playback for recording.';
        this.emit();
        return;
      }
    }

    // Extract internal media element stream (NO getDisplayMedia / NO screen capture)
    let stream: MediaStream;
    try {
      stream = captureMediaElementStream(this.video);
    } catch (err: unknown) {
      const msg =
        err instanceof DOMException && err.name === 'SecurityError'
          ? 'Browser security blocked captureStream() because this remote video server does not permit cross-origin (CORS) media access.'
          : err instanceof Error
            ? err.message
            : 'Unable to capture the media stream from the video player.';
      this.snapshot.recording.errorMessage = msg;
      this.emit();
      return;
    }

    // Wait briefly if tracks are still attaching right after play()
    if (stream.getTracks().length === 0) {
      await new Promise((resolve) => window.setTimeout(resolve, 200));
    }

    const videoTracks = stream.getVideoTracks();
    const audioTracks = stream.getAudioTracks();
    if (videoTracks.length === 0) {
      this.snapshot.recording.errorMessage =
        'No playable video track was exposed by captureStream(). The remote video may be cross-origin restricted or DRM protected.';
      this.emit();
      return;
    }

    this.snapshot.video.hasAudioTrack = audioTracks.length > 0;
    this.capturedStream = stream;

    // Release previous finalized artifact when starting a fresh take
    if (this.snapshot.recording.finalized) {
      revokeObjectUrlSafe(this.snapshot.recording.finalized.objectUrl);
      this.snapshot.recording.finalized = null;
    }

    this.chunks = [];
    this.accumulatedElapsedMs = 0;
    this.activeSegmentStartMs = null;
    this.isStoppingRecorder = false;

    const options = buildRecorderOptions(
      this.capabilities.preferredCodec,
      this.snapshot.recording.qualityPreset
    );

    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, options);
    } catch {
      // Fallback to browser default codec if preset bitrate/codec rejected
      try {
        recorder = new MediaRecorder(stream);
      } catch (fallbackErr: unknown) {
        this.snapshot.recording.errorMessage =
          fallbackErr instanceof Error
            ? `Failed to initialize MediaRecorder: ${fallbackErr.message}`
            : 'Failed to initialize MediaRecorder for this video stream.';
        this.emit();
        return;
      }
    }

    this.mediaRecorder = recorder;

    recorder.ondataavailable = (event: BlobEvent) => {
      if (event.data && event.data.size > 0) {
        this.chunks.push(event.data);
        this.snapshot.recording.chunkCount = this.chunks.length;
        this.snapshot.recording.recordedBytes += event.data.size;
        this.emit();
      }
    };

    recorder.onerror = () => {
      this.stopTimers();
      this.snapshot.recording.errorMessage =
        'MediaRecorder encountered an encoding error while capturing the video stream.';
      if (this.chunks.length > 0) {
        this.finalizeFromChunks(this.pendingEndReason);
      } else {
        this.snapshot.recording.isRecordingActive = false;
        this.snapshot.recording.isPaused = false;
        this.snapshot.recording.status = 'ready';
        this.emit();
      }
    };

    recorder.onstop = () => {
      this.stopTimers();
      this.finalizeFromChunks(this.pendingEndReason);
    };

    // Start recording with 1-second timeslice so chunks are continuously preserved
    recorder.start(1000);
    this.startActiveElapsedClock();
    this.startStallWatchdog();

    this.snapshot.recording = {
      ...this.snapshot.recording,
      status: 'recording',
      pauseReason: 'none',
      isRecordingActive: true,
      isPaused: false,
      elapsedMs: 0,
      chunkCount: 0,
      recordedBytes: 0,
      activeMimeType: recorder.mimeType || options.mimeType || 'video/webm',
      statusMessage:
        audioTracks.length > 0
          ? 'Capturing native video & audio stream directly from player.'
          : 'Capturing native video stream directly from player (no audio track detected).',
      errorMessage: null,
    };
    this.emit();
  }

  public pauseRecording(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') return;
    try {
      this.mediaRecorder.pause();
    } catch {
      return;
    }
    this.pauseActiveElapsedClock();
    this.snapshot.recording.status = 'paused';
    this.snapshot.recording.pauseReason = 'manual';
    this.snapshot.recording.isPaused = true;
    this.snapshot.recording.statusMessage =
      'Recording manually paused. All recorded chunks are preserved.';
    this.emit();
  }

  public resumeRecording(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'paused') return;
    if (!this.video) return;

    if (!this.snapshot.recording.isOnline && this.snapshot.video.sourceType !== 'file' && this.snapshot.video.sourceType !== 'synthetic') {
      this.snapshot.recording.statusMessage =
        'Waiting for network reconnection before resuming stream capture.';
      this.emit();
      return;
    }

    if (this.video.paused && !this.video.ended) {
      this.video.play().catch(() => {});
    }

    try {
      this.mediaRecorder.resume();
    } catch {
      return;
    }
    this.startActiveElapsedClock();
    this.snapshot.recording.status = 'recording';
    this.snapshot.recording.pauseReason = 'none';
    this.snapshot.recording.isPaused = false;
    this.snapshot.recording.statusMessage =
      'Recording resumed into the same session.';
    this.emit();
  }

  /**
   * Stops active recording ONLY, preserving chunks and finalizing the output
   * while allowing video playback to continue undisturbed.
   */
  public stopRecording(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive' || this.isStoppingRecorder) {
      return;
    }
    this.pendingEndReason = 'stop-recording';
    this.requestRecorderStop();
  }

  /**
   * Separate Stop Video button behavior:
   * Immediately halts video playback AND stops active recording together,
   * preserving all captured chunks and finalizing the recording for download.
   */
  public stopVideoAndRecording(): void {
    if (this.video) {
      this.video.pause();
      if (Number.isFinite(this.video.currentTime)) {
        this.video.currentTime = 0;
      }
      this.snapshot.video.isPlaying = false;
      this.snapshot.video.currentTime = 0;
    }

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive' && !this.isStoppingRecorder) {
      this.pendingEndReason = 'stop-video';
      this.requestRecorderStop();
    } else {
      if (!this.snapshot.recording.finalized) {
        this.snapshot.recording.status = this.snapshot.recording.isOnline ? 'ready' : 'offline';
        this.snapshot.recording.statusMessage = 'Video playback stopped.';
      }
      this.emit();
    }
  }

  public downloadFinalRecording(): boolean {
    const finalized = this.snapshot.recording.finalized;
    if (!finalized || this.snapshot.recording.isRecordingActive) {
      return false;
    }
    try {
      triggerRecordingDownload(finalized);
      return true;
    } catch (err: unknown) {
      this.snapshot.recording.errorMessage =
        err instanceof Error ? err.message : 'Unable to trigger file download.';
      this.emit();
      return false;
    }
  }

  public discardFinalRecording(): void {
    if (this.snapshot.recording.isRecordingActive) return;
    if (this.snapshot.recording.finalized) {
      revokeObjectUrlSafe(this.snapshot.recording.finalized.objectUrl);
      this.snapshot.recording.finalized = null;
      this.snapshot.recording.status = this.snapshot.recording.isOnline ? 'ready' : 'offline';
      this.snapshot.recording.elapsedMs = 0;
      this.snapshot.recording.chunkCount = 0;
      this.snapshot.recording.recordedBytes = 0;
      this.snapshot.recording.statusMessage = 'Previous take cleared. Ready for a new recording.';
      this.emit();
    }
  }

  // ---------------------------------------------------------------------------
  // Finalization Pipeline
  // ---------------------------------------------------------------------------

  private requestRecorderStop(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;
    this.isStoppingRecorder = true;
    this.pauseActiveElapsedClock();
    this.stopTimers();

    this.snapshot.recording.status = 'completed';
    this.snapshot.recording.statusMessage = 'Finalizing recorded chunks into downloadable file…';
    this.emit();

    try {
      this.mediaRecorder.stop();
    } catch {
      this.finalizeFromChunks(this.pendingEndReason);
    }
  }

  private finalizeFromChunks(endedReason: FinalizedRecording['endedReason']): void {
    this.isStoppingRecorder = false;
    const mimeType =
      this.mediaRecorder?.mimeType ||
      this.snapshot.recording.activeMimeType ||
      'video/webm';

    this.mediaRecorder = null;
    this.capturedStream = null;

    if (this.chunks.length === 0) {
      this.snapshot.recording.isRecordingActive = false;
      this.snapshot.recording.isPaused = false;
      this.snapshot.recording.pauseReason = 'none';
      this.snapshot.recording.status = 'ready';
      this.snapshot.recording.errorMessage =
        'No media data was captured before stopping. Ensure the video is playing and try again.';
      this.emit();
      return;
    }

    const finalized = assembleFinalRecording({
      chunks: this.chunks,
      mimeType,
      durationMs: this.accumulatedElapsedMs,
      width: this.snapshot.video.videoWidth,
      height: this.snapshot.video.videoHeight,
      endedReason,
    });

    const reasonText =
      endedReason === 'natural-end'
        ? 'Video reached its natural end. Recording automatically finalized and ready to download.'
        : endedReason === 'stop-video'
          ? 'Video playback and recording stopped together. Final file is ready to download.'
          : 'Recording stopped manually. All captured chunks combined and ready to download.';

    this.snapshot.recording = {
      ...this.snapshot.recording,
      status: 'download-ready',
      pauseReason: 'none',
      isRecordingActive: false,
      isPaused: false,
      elapsedMs: this.accumulatedElapsedMs,
      chunkCount: finalized.chunkCount,
      recordedBytes: finalized.sizeBytes,
      statusMessage: reasonText,
      errorMessage: null,
      finalized,
    };
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // Network & Buffering Auto-Pause / Auto-Resume Synchronization
  // ---------------------------------------------------------------------------

  private pauseForInterruption(reason: 'buffering' | 'offline' | 'video-paused', message: string): void {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'recording') return;

    try {
      this.mediaRecorder.pause();
    } catch {
      return;
    }

    this.pauseActiveElapsedClock();
    const nextStatus: RecorderStatus =
      reason === 'offline' ? 'offline' : reason === 'buffering' ? 'buffering' : 'paused';

    this.snapshot.recording.status = nextStatus;
    this.snapshot.recording.pauseReason = reason;
    this.snapshot.recording.isPaused = true;
    this.snapshot.recording.statusMessage = message;
    this.emit();
  }

  private tryAutoResumeAfterInterruption(): void {
    if (!this.mediaRecorder || this.mediaRecorder.state !== 'paused') return;

    const reason: PauseReason = this.snapshot.recording.pauseReason;
    // Never override an intentional manual user pause
    if (reason === 'manual' || reason === 'none') return;

    try {
      this.mediaRecorder.resume();
    } catch {
      return;
    }

    this.startActiveElapsedClock();
    this.snapshot.recording.status = 'recording';
    this.snapshot.recording.pauseReason = 'none';
    this.snapshot.recording.isPaused = false;
    this.snapshot.recording.statusMessage =
      reason === 'offline'
        ? 'Network restored and playback resumed — recording automatically continued.'
        : 'Playback resumed — recording automatically continued in the same session.';
    this.emit();
  }

  // ---------------------------------------------------------------------------
  // Timers & Stall Watchdog
  // ---------------------------------------------------------------------------

  private startActiveElapsedClock(): void {
    this.activeSegmentStartMs = performance.now();
    if (this.timerIntervalId === null) {
      this.timerIntervalId = window.setInterval(() => {
        if (this.activeSegmentStartMs !== null) {
          this.snapshot.recording.elapsedMs =
            this.accumulatedElapsedMs + (performance.now() - this.activeSegmentStartMs);
          this.emit();
        }
      }, 100);
    }
  }

  private pauseActiveElapsedClock(): void {
    if (this.activeSegmentStartMs !== null) {
      this.accumulatedElapsedMs += performance.now() - this.activeSegmentStartMs;
      this.activeSegmentStartMs = null;
      this.snapshot.recording.elapsedMs = this.accumulatedElapsedMs;
    }
    if (this.timerIntervalId !== null) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
  }

  private startStallWatchdog(): void {
    this.lastObservedVideoTime = this.video?.currentTime ?? -1;
    this.stagnantTicks = 0;

    if (this.watchdogIntervalId !== null) {
      clearInterval(this.watchdogIntervalId);
    }

    this.watchdogIntervalId = window.setInterval(() => {
      if (!this.video || !this.mediaRecorder) return;

      if (
        this.mediaRecorder.state === 'recording' &&
        !this.video.paused &&
        !this.video.ended
      ) {
        const current = this.video.currentTime;
        if (Math.abs(current - this.lastObservedVideoTime) < 0.01 && this.video.readyState < 3) {
          this.stagnantTicks += 1;
          if (this.stagnantTicks >= 2) {
            const isOffline = !navigator.onLine;
            this.pauseForInterruption(
              isOffline ? 'offline' : 'buffering',
              isOffline
                ? 'Network disconnected — recording auto-paused with chunks preserved.'
                : 'Playback stalled while buffering — recording auto-paused with chunks preserved.'
            );
          }
        } else {
          this.stagnantTicks = 0;
        }
        this.lastObservedVideoTime = current;
      }
    }, 500);
  }

  private stopTimers(): void {
    if (this.timerIntervalId !== null) {
      clearInterval(this.timerIntervalId);
      this.timerIntervalId = null;
    }
    if (this.watchdogIntervalId !== null) {
      clearInterval(this.watchdogIntervalId);
      this.watchdogIntervalId = null;
    }
  }

  // ---------------------------------------------------------------------------
  // HTMLVideoElement & Network Event Handlers
  // ---------------------------------------------------------------------------

  private updateBufferedMetrics(): void {
    if (!this.video) return;
    const duration = this.video.duration;
    if (Number.isFinite(duration) && duration > 0 && this.video.buffered.length > 0) {
      const bufferedEnd = this.video.buffered.end(this.video.buffered.length - 1);
      const pct = Math.min(100, Math.round((bufferedEnd / duration) * 100));
      this.snapshot.video.bufferedPercent = pct;
      if (!this.snapshot.video.isLoaded) {
        this.snapshot.video.loadProgress = Math.max(this.snapshot.video.loadProgress, pct);
      }
    }
  }

  private onVideoLoadStart = (): void => {
    this.snapshot.video.loadProgress = 12;
    this.snapshot.video.errorMessage = null;
    if (!this.snapshot.recording.isRecordingActive) {
      this.snapshot.recording.status = 'loading';
      this.snapshot.recording.statusMessage = 'Connecting to video source…';
    }
    this.emit();
  };

  private onVideoProgress = (): void => {
    this.updateBufferedMetrics();
    this.emit();
  };

  private onVideoLoadedMetadata = (): void => {
    if (!this.video) return;
    this.snapshot.video.duration = Number.isFinite(this.video.duration) ? this.video.duration : 0;
    this.snapshot.video.videoWidth = this.video.videoWidth;
    this.snapshot.video.videoHeight = this.video.videoHeight;
    this.snapshot.video.isMuted = this.video.muted;
    this.snapshot.video.loadProgress = 70;
    this.updateBufferedMetrics();
    this.emit();
  };

  private onVideoLoadedData = (): void => {
    this.snapshot.video.loadProgress = 92;
    this.updateBufferedMetrics();
    this.emit();
  };

  private onVideoCanPlay = (): void => {
    if (!this.video) return;
    this.snapshot.video.isLoaded = true;
    this.snapshot.video.loadProgress = 100;
    this.updateBufferedMetrics();

    if (!this.snapshot.recording.isRecordingActive) {
      const hasFinalized = Boolean(this.snapshot.recording.finalized);
      this.snapshot.recording.status = hasFinalized
        ? 'download-ready'
        : this.snapshot.recording.isOnline
          ? 'ready'
          : 'offline';
      this.snapshot.recording.statusMessage = hasFinalized
        ? this.snapshot.recording.statusMessage
        : 'Video loaded and ready to capture.';
    } else if (
      this.mediaRecorder?.state === 'paused' &&
      (this.snapshot.recording.pauseReason === 'buffering' ||
        this.snapshot.recording.pauseReason === 'offline') &&
      !this.video.paused
    ) {
      this.tryAutoResumeAfterInterruption();
    }
    this.emit();
  };

  private onVideoPlay = (): void => {
    this.snapshot.video.isPlaying = true;
    this.emit();
  };

  private onVideoPlaying = (): void => {
    this.snapshot.video.isPlaying = true;
    this.stagnantTicks = 0;

    if (
      this.mediaRecorder?.state === 'paused' &&
      (this.snapshot.recording.pauseReason === 'buffering' ||
        this.snapshot.recording.pauseReason === 'offline' ||
        this.snapshot.recording.pauseReason === 'video-paused')
    ) {
      this.tryAutoResumeAfterInterruption();
    } else if (!this.snapshot.recording.isRecordingActive && this.snapshot.recording.status === 'buffering') {
      this.snapshot.recording.status = this.snapshot.recording.finalized ? 'download-ready' : 'ready';
    }
    this.emit();
  };

  private onVideoPause = (): void => {
    if (!this.video) return;
    this.snapshot.video.isPlaying = false;

    // If user paused video playback while actively recording (and video didn't end),
    // auto-pause MediaRecorder so frozen frames aren't encoded, and auto-resume on play.
    if (
      !this.video.ended &&
      !this.isStoppingRecorder &&
      this.mediaRecorder?.state === 'recording'
    ) {
      this.pauseForInterruption(
        'video-paused',
        'Video playback paused — recording auto-paused until playback resumes.'
      );
      return;
    }

    this.emit();
  };

  private onVideoWaiting = (): void => {
    if (this.mediaRecorder?.state === 'recording') {
      const isOffline = !navigator.onLine;
      this.pauseForInterruption(
        isOffline ? 'offline' : 'buffering',
        isOffline
          ? 'Network disconnected — recording paused automatically. Chunks preserved.'
          : 'Video buffering — recording paused automatically. Chunks preserved.'
      );
    } else if (!this.snapshot.recording.isRecordingActive && this.snapshot.video.isLoaded) {
      this.snapshot.recording.status = navigator.onLine ? 'buffering' : 'offline';
      this.snapshot.recording.statusMessage = navigator.onLine
        ? 'Buffering video stream…'
        : 'Network disconnected while streaming video.';
      this.emit();
    }
  };

  private onVideoStalled = (): void => {
    if (this.mediaRecorder?.state === 'recording') {
      const isOffline = !navigator.onLine;
      this.pauseForInterruption(
        isOffline ? 'offline' : 'buffering',
        isOffline
          ? 'Network connection lost — recording paused automatically until connection returns.'
          : 'Media stream stalled — recording paused automatically until playback advances.'
      );
    } else if (!this.snapshot.recording.isRecordingActive && this.snapshot.video.isLoaded && !navigator.onLine) {
      this.snapshot.recording.status = 'offline';
      this.snapshot.recording.statusMessage = 'Network disconnected.';
      this.emit();
    }
  };

  private onVideoTimeUpdate = (): void => {
    if (!this.video) return;
    const current = this.video.currentTime;
    this.snapshot.video.currentTime = current;
    if (Number.isFinite(this.video.duration) && this.video.duration > 0) {
      this.snapshot.video.duration = this.video.duration;
    }
    this.updateBufferedMetrics();

    // Secondary recovery check if playback advances after stall without firing a fresh 'playing' event
    if (
      this.mediaRecorder?.state === 'paused' &&
      (this.snapshot.recording.pauseReason === 'buffering' ||
        this.snapshot.recording.pauseReason === 'offline') &&
      !this.video.paused &&
      this.video.readyState >= 3 &&
      Math.abs(current - this.lastObservedVideoTime) > 0.05
    ) {
      this.lastObservedVideoTime = current;
      this.tryAutoResumeAfterInterruption();
      return;
    }

    this.emit();
  };

  private onVideoVolumeChange = (): void => {
    if (!this.video) return;
    this.snapshot.video.isMuted = this.video.muted || this.video.volume === 0;
    this.emit();
  };

  private onVideoEnded = (): void => {
    this.snapshot.video.isPlaying = false;
    if (this.video && Number.isFinite(this.video.duration)) {
      this.snapshot.video.currentTime = this.video.duration;
    }

    // Automatic recording termination on natural video end
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive' && !this.isStoppingRecorder) {
      this.pendingEndReason = 'natural-end';
      this.requestRecorderStop();
      return;
    }

    this.emit();
  };

  private attachHlsStream(manifestProxyUrl: string, seqId: number): void {
    if (!this.video) return;
    this.destroyHlsInstance();

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
      });
      this.hlsInstance = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        if (seqId !== this.loadSequenceId) return;
        this.snapshot.video.loadProgress = 65;
        this.emit();
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (seqId !== this.loadSequenceId) return;
        if (!data.fatal) return;

        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          if (this.snapshot.recording.isRecordingActive) {
            this.pauseForInterruption(
              navigator.onLine ? 'buffering' : 'offline',
              navigator.onLine
                ? 'HLS stream interrupted — recording auto-paused while reconnecting.'
                : 'Network disconnected — recording auto-paused until connection returns.'
            );
            hls.startLoad();
            return;
          }
          this.destroyHlsInstance();
          this.snapshot.video.isLoaded = false;
          this.snapshot.video.loadProgress = 0;
          this.snapshot.video.errorMessage =
            'Unable to fetch HLS video segments from the remote server. The stream token may have expired or access may be restricted.';
          this.snapshot.recording.status = this.snapshot.recording.isOnline ? 'ready' : 'offline';
          this.snapshot.recording.statusMessage = 'HLS stream failed to load.';
          this.emit();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls.recoverMediaError();
        } else {
          this.destroyHlsInstance();
          this.snapshot.video.isLoaded = false;
          this.snapshot.video.loadProgress = 0;
          this.snapshot.video.errorMessage =
            'Fatal HLS playback error. This stream may use unsupported encryption or DRM.';
          this.snapshot.recording.status = this.snapshot.recording.isOnline ? 'ready' : 'offline';
          this.snapshot.recording.statusMessage = 'HLS stream failed to decode.';
          this.emit();
        }
      });

      hls.loadSource(manifestProxyUrl);
      hls.attachMedia(this.video);
      return;
    }

    // Native Safari HLS support
    if (this.video.canPlayType('application/vnd.apple.mpegurl')) {
      this.video.src = manifestProxyUrl;
      this.video.load();
      return;
    }

    this.snapshot.video.errorMessage =
      'This browser does not support HLS (.m3u8) Media Source playback.';
    this.snapshot.recording.status = 'ready';
    this.emit();
  }

  private async attemptSameOriginProxyFallback(remoteUrl: string, seqId: number): Promise<void> {
    const resolved = await resolveRemoteVideoUrl(remoteUrl);
    if (seqId !== this.loadSequenceId || !this.video) return;

    if (!resolved.ok || !resolved.resolvedUrl) {
      this.snapshot.video.isLoaded = false;
      this.snapshot.video.isPlaying = false;
      this.snapshot.video.loadProgress = 0;
      this.snapshot.video.viaProxy = false;
      this.snapshot.video.errorMessage =
        resolved.error ||
        'This URL could not be loaded as a playable HTML5 video stream, even via the same-origin proxy.';
      this.snapshot.recording.status = this.snapshot.recording.isOnline ? 'ready' : 'offline';
      this.snapshot.recording.statusMessage = 'Video failed to load. Check source compatibility.';
      this.emit();
      return;
    }

    const proxyUrl = buildSameOriginProxyUrl(resolved.resolvedUrl, resolved.refererOrigin);
    this.video.pause();
    this.video.removeAttribute('crossorigin');

    const isHls = resolved.streamFormat === 'hls' || isLikelyHlsUrl(resolved.resolvedUrl);

    this.snapshot.video = {
      ...this.snapshot.video,
      viaProxy: true,
      isLoaded: false,
      loadProgress: 30,
      errorMessage: null,
    };
    this.snapshot.recording.status = 'loading';
    this.snapshot.recording.statusMessage = isHls
      ? 'HLS stream resolved — loading playlist through same-origin proxy…'
      : resolved.kind === 'extracted'
        ? 'Direct video stream found on page — loading through same-origin proxy…'
        : 'Remote server lacks CORS headers — streaming through same-origin proxy…';
    this.emit();

    if (isHls) {
      this.attachHlsStream(proxyUrl, seqId);
    } else {
      this.video.src = proxyUrl;
      this.video.load();
    }
  }

  private onVideoError = (): void => {
    if (!this.video) return;

    const currentSource = this.snapshot.video.sourceUrl;
    const isRemoteHttp =
      currentSource.startsWith('http://') || currentSource.startsWith('https://');

    // Automatically fall back to same-origin media proxy if a remote URL failed direct CORS load
    if (
      isRemoteHttp &&
      !this.hasTriedProxyFallback &&
      !this.snapshot.recording.isRecordingActive
    ) {
      this.hasTriedProxyFallback = true;
      this.snapshot.video.errorMessage = null;
      this.snapshot.video.loadProgress = 18;
      this.snapshot.recording.status = 'loading';
      this.snapshot.recording.statusMessage =
        'Direct CORS load blocked — resolving via same-origin media proxy…';
      this.emit();
      void this.attemptSameOriginProxyFallback(currentSource, this.loadSequenceId);
      return;
    }

    const errMsg = classifyVideoLoadError(this.video, currentSource);
    this.snapshot.video.isLoaded = false;
    this.snapshot.video.isPlaying = false;
    this.snapshot.video.loadProgress = 0;
    this.snapshot.video.errorMessage = errMsg;

    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      // Preserve previously captured chunks if stream errors mid-recording
      if (this.chunks.length > 0) {
        this.pendingEndReason = 'stop-video';
        this.requestRecorderStop();
        return;
      }
    }

    this.snapshot.recording.status = this.snapshot.recording.isOnline ? 'ready' : 'offline';
    this.snapshot.recording.statusMessage = 'Video failed to load. Check source compatibility.';
    this.emit();
  };

  private onWindowOffline = (): void => {
    this.snapshot.recording.isOnline = false;

    const isRemoteSource =
      this.snapshot.video.sourceType === 'url' || this.snapshot.video.sourceType === 'sample';

    if (this.mediaRecorder?.state === 'recording') {
      // Immediately pause recording when offline so chunks stay intact and no frozen gap is recorded
      this.pauseForInterruption(
        'offline',
        'Network disconnected — recording automatically paused. All recorded chunks are safe.'
      );
      return;
    }

    if (!this.snapshot.recording.isRecordingActive && isRemoteSource) {
      this.snapshot.recording.status = 'offline';
      this.snapshot.recording.statusMessage =
        'Network disconnected. Waiting for connectivity to resume remote playback.';
    }
    this.emit();
  };

  private onWindowOnline = (): void => {
    this.snapshot.recording.isOnline = true;

    if (
      this.mediaRecorder?.state === 'paused' &&
      this.snapshot.recording.pauseReason === 'offline'
    ) {
      this.snapshot.recording.status = 'buffering';
      this.snapshot.recording.statusMessage =
        'Connection restored — waiting for video playback to resume automatically…';
      this.emit();

      if (this.video && this.video.paused && !this.video.ended) {
        this.video.play().catch(() => {});
      }
      return;
    }

    if (!this.snapshot.recording.isRecordingActive && this.snapshot.recording.status === 'offline') {
      this.snapshot.recording.status = this.snapshot.recording.finalized
        ? 'download-ready'
        : 'ready';
      this.snapshot.recording.statusMessage = 'Connection restored.';
    }
    this.emit();
  };
}
