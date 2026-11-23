import { CheckCircle2, Download, Film, Trash2 } from 'lucide-react';
import { formatBroadcastTimecode, formatFileSize } from '../engine/fileDownloader';
import type { FinalizedRecording } from '../engine/types';

interface FinalPreviewDeckProps {
  finalized: FinalizedRecording | null;
  isRecordingActive: boolean;
  onDownload: () => void;
  onDiscard: () => void;
}

const END_REASON_LABELS: Record<FinalizedRecording['endedReason'], string> = {
  'natural-end': 'Auto-stopped at video end',
  'stop-recording': 'Stopped manually (Stop Recording)',
  'stop-video': 'Stopped with player (Stop Video)',
};

export function FinalPreviewDeck({
  finalized,
  isRecordingActive,
  onDownload,
  onDiscard,
}: FinalPreviewDeckProps) {
  return (
    <section
      id="preview"
      aria-labelledby="final-preview-heading"
      className="border border-[#E1E4EC] bg-white dark:border-[#252936] dark:bg-[#12141C]"
    >
      <div className="flex flex-wrap items-center justify-between gap-4 border-b border-[#E8EBF1] px-5 py-4 dark:border-[#1F2330]">
        <div>
          <h2
            id="final-preview-heading"
            className="font-display text-base font-semibold text-[#111318] dark:text-[#ECEEF4]"
          >
            Finalized Recording Preview
          </h2>
          <p className="mt-0.5 text-xs text-[#5A6174] dark:text-[#8E95A8]">
            Verify your combined video and audio capture before saving locally.
          </p>
        </div>

        {finalized && (
          <div className="flex items-center gap-2 text-xs font-medium text-[#16A34A] dark:text-[#4ADE80]">
            <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
            <span>Finalized &amp; Ready</span>
          </div>
        )}
      </div>

      {!finalized ? (
        <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
          <Film className="h-9 w-9 text-[#9CA3B5] dark:text-[#3F465A]" aria-hidden="true" />
          <p className="mt-3 font-display text-sm font-semibold text-[#111318] dark:text-[#ECEEF4]">
            No Finalized Recording Yet
          </p>
          <p className="mt-1 max-w-lg text-xs leading-relaxed text-[#5A6174] dark:text-[#8E95A8]">
            Start recording a loaded video above. When the video finishes naturally, or when you
            click Stop Recording or Stop Video, all captured media chunks will merge into a single
            playable preview here.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12">
          {/* Recorded Output Video Preview */}
          <div className="border-b border-[#E8EBF1] bg-[#07080C] lg:col-span-7 lg:border-r lg:border-b-0 dark:border-[#1F2330]">
            <video
              key={finalized.objectUrl}
              src={finalized.objectUrl}
              controls
              playsInline
              className="aspect-video h-full w-full object-contain"
            />
          </div>

          {/* Verified File Stats & Download Controls */}
          <div className="flex flex-col justify-between p-5 lg:col-span-5">
            <div>
              <h3 className="font-display text-sm font-semibold text-[#111318] dark:text-[#ECEEF4]">
                Output File Summary
              </h3>

              <dl className="mt-4 divide-y divide-[#ECEEF4] text-xs dark:divide-[#1F2330]">
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-[#5A6174] dark:text-[#8E95A8]">Filename</dt>
                  <dd className="truncate font-mono font-medium text-[#111318] dark:text-[#ECEEF4]">
                    {finalized.filename}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-[#5A6174] dark:text-[#8E95A8]">Recorded Duration</dt>
                  <dd className="font-mono font-medium text-[#111318] tabular-nums dark:text-[#ECEEF4]">
                    {formatBroadcastTimecode(finalized.durationMs)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-[#5A6174] dark:text-[#8E95A8]">File Size</dt>
                  <dd className="font-mono font-medium text-[#111318] tabular-nums dark:text-[#ECEEF4]">
                    {formatFileSize(finalized.sizeBytes)}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-[#5A6174] dark:text-[#8E95A8]">Resolution</dt>
                  <dd className="font-mono font-medium text-[#111318] tabular-nums dark:text-[#ECEEF4]">
                    {finalized.width > 0 && finalized.height > 0
                      ? `${finalized.width}×${finalized.height}`
                      : 'Source Native'}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-[#5A6174] dark:text-[#8E95A8]">Container &amp; Codec</dt>
                  <dd className="truncate font-mono font-medium text-[#111318] dark:text-[#ECEEF4]">
                    {finalized.mimeType}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-[#5A6174] dark:text-[#8E95A8]">Chunks Combined</dt>
                  <dd className="font-mono font-medium text-[#111318] tabular-nums dark:text-[#ECEEF4]">
                    {finalized.chunkCount}
                  </dd>
                </div>
                <div className="flex items-center justify-between gap-4 py-2.5">
                  <dt className="text-[#5A6174] dark:text-[#8E95A8]">Finalization</dt>
                  <dd className="font-medium text-[#111318] dark:text-[#ECEEF4]">
                    {END_REASON_LABELS[finalized.endedReason]}
                  </dd>
                </div>
              </dl>
            </div>

            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                onClick={onDownload}
                disabled={isRecordingActive}
                className="inline-flex h-11 flex-1 cursor-pointer items-center justify-center gap-2 whitespace-nowrap rounded-md bg-[#2563EB] px-4 text-sm font-semibold text-white transition-colors duration-150 hover:bg-[#1D4ED8] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Download className="h-4 w-4" aria-hidden="true" />
                <span>Download Final Video</span>
              </button>

              <button
                type="button"
                onClick={onDiscard}
                disabled={isRecordingActive}
                className="inline-flex h-11 shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-[#D4D8E2] bg-white px-4 text-xs font-medium text-[#5A6174] transition-colors duration-150 hover:bg-[#F2F4F8] hover:text-[#111318] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] disabled:cursor-not-allowed disabled:opacity-50 dark:border-[#2A2F3E] dark:bg-[#171A25] dark:text-[#8E95A8] dark:hover:bg-[#202433] dark:hover:text-[#ECEEF4]"
              >
                <Trash2 className="h-4 w-4" aria-hidden="true" />
                <span>Clear Take</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
