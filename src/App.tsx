import { useEffect, useMemo, useRef, useState } from 'react';
import { BrowserSupportSection } from './components/BrowserSupportSection';
import { FinalPreviewDeck } from './components/FinalPreviewDeck';
import { Header } from './components/Header';
import { RecordingDashboard } from './components/RecordingDashboard';
import { SourceBar } from './components/SourceBar';
import { VideoMonitor } from './components/VideoMonitor';
import { VideoRecordingEngine } from './engine/recordingEngine';
import type { EngineSnapshot, QualityPresetId, SampleVideoItem } from './engine/types';
import { generateBroadcastTestClip } from './engine/videoLoader';

type ThemeMode = 'dark' | 'light';

function getInitialTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'dark';
  const stored = window.localStorage.getItem('signaldeck-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return 'dark';
}

export default function App() {
  const [theme, setTheme] = useState<ThemeMode>(getInitialTheme);
  const [isGeneratingSample, setIsGeneratingSample] = useState(false);
  const [sampleProgress, setSampleProgress] = useState(0);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const engine = useMemo(() => new VideoRecordingEngine(), []);
  const capabilities = useMemo(() => engine.getCapabilities(), [engine]);
  const [snapshot, setSnapshot] = useState<EngineSnapshot>(() => engine.getSnapshot());

  // Sync Tailwind v4 `.dark` class on <html> and persist preference
  useEffect(() => {
    const root = document.documentElement;
    if (theme === 'dark') {
      root.classList.add('dark');
    } else {
      root.classList.remove('dark');
    }
    try {
      window.localStorage.setItem('signaldeck-theme', theme);
    } catch {
      // Ignore storage restrictions
    }
  }, [theme]);

  // Attach recording engine to HTML5 <video> element and subscribe to state updates
  useEffect(() => {
    const unsubscribe = engine.subscribe((next) => {
      setSnapshot(next);
    });
    if (videoRef.current) {
      engine.attachVideoElement(videoRef.current);
    }
    return () => {
      unsubscribe();
      engine.destroy();
    };
  }, [engine]);

  const handleLoadUrl = (url: string) => {
    engine.loadDirectUrl(url, url.trim(), 'url');
  };

  const handleSelectSample = async (sample: SampleVideoItem) => {
    if (sample.type === 'sample') {
      engine.loadDirectUrl(sample.url, sample.title, 'sample');
      return;
    }

    // Generate offline local Broadcast Test Clip (video + Web Audio sync pulse)
    setIsGeneratingSample(true);
    setSampleProgress(0);
    try {
      const { objectUrl, label } = await generateBroadcastTestClip((pct) => {
        setSampleProgress(pct);
      });
      engine.loadBlobSource(objectUrl, label, 'synthetic');
    } catch (err: unknown) {
      engine.setVideoError(
        err instanceof Error
          ? err.message
          : 'Could not generate the offline broadcast test clip in this browser.'
      );
    } finally {
      setIsGeneratingSample(false);
      setSampleProgress(0);
    }
  };

  const handleSelectLocalFile = (file: File) => {
    const objectUrl = URL.createObjectURL(file);
    engine.loadBlobSource(objectUrl, file.name, 'file');
  };

  const handleSelectQuality = (preset: QualityPresetId) => {
    engine.setQualityPreset(preset);
  };

  return (
    <div className="min-h-screen bg-[#F5F6F9] text-[#111318] transition-colors duration-150 dark:bg-[#090A0F] dark:text-[#ECEEF4]">
      <Header
        theme={theme}
        onToggleTheme={() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark'))}
      />

      <main id="recorder" className="mx-auto max-w-[1360px] space-y-6 px-4 py-6 sm:px-6 lg:px-8">
        {/* Video URL, Sample Clips, and Local File Bar */}
        <SourceBar
          isRecordingActive={snapshot.recording.isRecordingActive}
          isGeneratingSample={isGeneratingSample}
          sampleGenerationProgress={sampleProgress}
          activeSourceUrl={snapshot.video.sourceUrl}
          onLoadUrl={handleLoadUrl}
          onSelectSample={handleSelectSample}
          onSelectLocalFile={handleSelectLocalFile}
        />

        {/* Primary Asymmetric Broadcast Studio Split: Monitor (~65%) + Recording Deck (~35%) */}
        <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-12">
          <div className="lg:col-span-8">
            <VideoMonitor
              videoRef={videoRef}
              videoState={snapshot.video}
              recorderStatus={snapshot.recording.status}
              isRecordingActive={snapshot.recording.isRecordingActive}
              onTogglePlayPause={() => engine.togglePlayPause()}
              onSeek={(sec) => engine.seekTo(sec)}
            />
          </div>

          <div className="lg:col-span-4">
            <RecordingDashboard
              recording={snapshot.recording}
              isVideoLoaded={snapshot.video.isLoaded}
              hasVideoSource={Boolean(snapshot.video.sourceUrl)}
              onStartRecording={() => {
                void engine.startRecording();
              }}
              onPauseRecording={() => engine.pauseRecording()}
              onResumeRecording={() => engine.resumeRecording()}
              onStopRecording={() => engine.stopRecording()}
              onStopVideo={() => engine.stopVideoAndRecording()}
              onDownloadFinal={() => engine.downloadFinalRecording()}
              onSelectQuality={handleSelectQuality}
            />
          </div>
        </div>

        {/* Finalized Recording Playback Preview & Verified File Stats */}
        <FinalPreviewDeck
          finalized={snapshot.recording.finalized}
          isRecordingActive={snapshot.recording.isRecordingActive}
          onDownload={() => engine.downloadFinalRecording()}
          onDiscard={() => engine.discardFinalRecording()}
        />

        {/* Live Browser API Support & Honest Security Limitations */}
        <BrowserSupportSection capabilities={capabilities} />
      </main>

      <footer className="mt-8 border-t border-[#E1E4EC] py-6 text-center text-xs text-[#6B7285] dark:border-[#1E222E] dark:text-[#6D758B]">
        <div className="mx-auto max-w-[1360px] px-4 sm:px-6 lg:px-8">
          SignalDeck · Direct HTML5 MediaStream Recorder · Local Client-Side Processing Only
        </div>
      </footer>
    </div>
  );
}
