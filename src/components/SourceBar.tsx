import { Film, FolderOpen, Link2, Loader2 } from 'lucide-react';
import { type ChangeEvent, type FormEvent, useRef, useState } from 'react';
import type { SampleVideoItem } from '../engine/types';
import { SAMPLE_VIDEO_CLIPS } from '../engine/videoLoader';

interface SourceBarProps {
  isRecordingActive: boolean;
  isGeneratingSample: boolean;
  sampleGenerationProgress: number;
  activeSourceUrl: string;
  onLoadUrl: (url: string) => void;
  onSelectSample: (sample: SampleVideoItem) => void;
  onSelectLocalFile: (file: File) => void;
}

export function SourceBar({
  isRecordingActive,
  isGeneratingSample,
  sampleGenerationProgress,
  activeSourceUrl,
  onLoadUrl,
  onSelectSample,
  onSelectLocalFile,
}: SourceBarProps) {
  const [urlInput, setUrlInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    onLoadUrl(urlInput);
  };

  const handleFileChange = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      setUrlInput(file.name);
      onSelectLocalFile(file);
    }
    event.target.value = '';
  };

  const handleSampleClick = (sample: SampleVideoItem) => {
    if (sample.type === 'sample') {
      setUrlInput(sample.url);
    } else {
      setUrlInput('');
    }
    onSelectSample(sample);
  };

  return (
    <section
      aria-label="Video Source Input"
      className="border border-[#E1E4EC] bg-white p-5 dark:border-[#252936] dark:bg-[#12141C]"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-3 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <label htmlFor="video-url-input" className="sr-only">
            Direct Video URL
          </label>
          <Link2
            className="pointer-events-none absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-[#6B7285] dark:text-[#7E869B]"
            aria-hidden="true"
          />
          <input
            id="video-url-input"
            type="text"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            disabled={isRecordingActive || isGeneratingSample}
            placeholder="Paste a direct CORS-enabled video URL (https://…/video.mp4 or .webm)"
            className="h-11 w-full rounded-md border border-[#D4D8E2] bg-[#F8F9FB] pr-4 pl-10 font-mono text-sm text-[#111318] placeholder-[#7B8296] transition-colors focus:border-[#2563EB] focus:bg-white focus:outline-none disabled:cursor-not-allowed disabled:opacity-60 dark:border-[#2A2F3E] dark:bg-[#0B0D13] dark:text-[#ECEEF4] dark:placeholder-[#656D82] dark:focus:border-[#3B82F6] dark:focus:bg-[#0D1018]"
          />
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2.5">
          <button
            type="submit"
            disabled={isRecordingActive || isGeneratingSample}
            className="inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[#2563EB] px-5 text-sm font-semibold text-white transition-colors duration-150 hover:bg-[#1D4ED8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Load Video
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept="video/mp4,video/webm,video/ogg,video/*"
            onChange={handleFileChange}
            className="hidden"
          />
          <button
            type="button"
            disabled={isRecordingActive || isGeneratingSample}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md border border-[#D4D8E2] bg-white px-4 text-sm font-medium text-[#111318] transition-colors duration-150 hover:bg-[#F2F4F8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#2A2F3E] dark:bg-[#171A25] dark:text-[#ECEEF4] dark:hover:bg-[#202433]"
          >
            <FolderOpen className="h-4 w-4 text-[#5A6174] dark:text-[#8E95A8]" aria-hidden="true" />
            <span>Local File</span>
          </button>
        </div>
      </form>

      {/* Quick-load Sample Clips bar */}
      <div className="mt-4 flex flex-col gap-2.5 border-t border-[#E8EBF1] pt-3.5 sm:flex-row sm:items-center sm:justify-between dark:border-[#1E222E]">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-xs text-[#5A6174] dark:text-[#8E95A8]">
          <span className="font-medium text-[#111318] dark:text-[#CBD1E0]">Quick Samples:</span>
          {SAMPLE_VIDEO_CLIPS.map((sample) => {
            const isSelected = sample.url !== '' && activeSourceUrl === sample.url;
            return (
              <button
                key={sample.id}
                type="button"
                disabled={isRecordingActive || isGeneratingSample}
                onClick={() => handleSampleClick(sample)}
                className={`inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap rounded px-2.5 text-xs font-medium transition-colors duration-150 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-50 ${
                  isSelected
                    ? 'bg-[#2563EB]/12 text-[#1D4ED8] dark:bg-[#2563EB]/20 dark:text-[#93C5FD]'
                    : 'bg-[#F2F4F8] text-[#353B4B] hover:bg-[#E6E9F0] dark:bg-[#191D29] dark:text-[#B8BFD2] dark:hover:bg-[#232838]'
                }`}
                title={sample.description}
              >
                <Film className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{sample.title}</span>
                <span className="font-mono tabular-nums opacity-70">{sample.durationHint}</span>
              </button>
            );
          })}
        </div>

        {isGeneratingSample && (
          <div className="flex shrink-0 items-center gap-2 font-mono text-xs text-[#2563EB] tabular-nums dark:text-[#60A5FA]">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            <span>Synthesizing test clip {sampleGenerationProgress}%</span>
          </div>
        )}
      </div>
    </section>
  );
}
