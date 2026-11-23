import { CheckCircle2, Info, XCircle } from 'lucide-react';
import type { BrowserCapabilities } from '../engine/types';

interface BrowserSupportSectionProps {
  capabilities: BrowserCapabilities;
}

export function BrowserSupportSection({ capabilities }: BrowserSupportSectionProps) {
  return (
    <section
      id="compatibility"
      aria-labelledby="compatibility-heading"
      className="border border-[#E1E4EC] bg-white dark:border-[#252936] dark:bg-[#12141C]"
    >
      <div className="border-b border-[#E8EBF1] px-5 py-4 dark:border-[#1F2330]">
        <h2
          id="compatibility-heading"
          className="font-display text-base font-semibold text-[#111318] dark:text-[#ECEEF4]"
        >
          Browser Capabilities &amp; Stream Capture Limitations
        </h2>
        <p className="mt-0.5 text-xs text-[#5A6174] dark:text-[#8E95A8]">
          SignalDeck records directly from the HTML5 video element using native browser APIs—never screen sharing.
        </p>
      </div>

      <div className="grid grid-cols-1 divide-y divide-[#E8EBF1] lg:grid-cols-2 lg:divide-x lg:divide-y-0 dark:divide-[#1F2330]">
        {/* Live Browser API Diagnostics */}
        <div className="p-5">
          <h3 className="font-display text-sm font-semibold text-[#111318] dark:text-[#ECEEF4]">
            Detected Environment Support
          </h3>
          <dl className="mt-3.5 divide-y divide-[#ECEEF4] text-xs dark:divide-[#1F2330]">
            <div className="flex items-center justify-between gap-4 py-2.5">
              <dt className="text-[#5A6174] dark:text-[#8E95A8]">HTMLMediaElement.captureStream()</dt>
              <dd className="inline-flex items-center gap-1.5 font-mono font-medium">
                {capabilities.hasCaptureStream ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#16A34A] dark:text-emerald-400" aria-hidden="true" />
                    <span className="text-[#111318] dark:text-[#ECEEF4]">{capabilities.captureMethod}</span>
                  </>
                ) : (
                  <>
                    <XCircle className="h-3.5 w-3.5 text-[#DC2626] dark:text-red-400" aria-hidden="true" />
                    <span className="text-[#DC2626] dark:text-red-400">Unavailable</span>
                  </>
                )}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-4 py-2.5">
              <dt className="text-[#5A6174] dark:text-[#8E95A8]">MediaRecorder API</dt>
              <dd className="inline-flex items-center gap-1.5 font-mono font-medium">
                {capabilities.hasMediaRecorder ? (
                  <>
                    <CheckCircle2 className="h-3.5 w-3.5 text-[#16A34A] dark:text-emerald-400" aria-hidden="true" />
                    <span className="text-[#111318] dark:text-[#ECEEF4]">Supported</span>
                  </>
                ) : (
                  <>
                    <XCircle className="h-3.5 w-3.5 text-[#DC2626] dark:text-red-400" aria-hidden="true" />
                    <span className="text-[#DC2626] dark:text-red-400">Unavailable</span>
                  </>
                )}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-4 py-2.5">
              <dt className="text-[#5A6174] dark:text-[#8E95A8]">Selected Preferred Codec</dt>
              <dd className="font-mono font-medium text-[#111318] dark:text-[#ECEEF4]">
                {capabilities.preferredCodec?.label ?? 'Browser Default'}
              </dd>
            </div>

            <div className="flex items-center justify-between gap-4 py-2.5">
              <dt className="text-[#5A6174] dark:text-[#8E95A8]">Supported Codecs Detected</dt>
              <dd className="font-mono font-medium text-[#111318] tabular-nums dark:text-[#ECEEF4]">
                {capabilities.supportedCodecs.length} profiles
              </dd>
            </div>
          </dl>
        </div>

        {/* Honest Browser Security & CORS Notes */}
        <div className="p-5">
          <h3 className="font-display text-sm font-semibold text-[#111318] dark:text-[#ECEEF4]">
            Important Browser Security Notes
          </h3>
          <ul className="mt-3.5 space-y-2.5 text-xs leading-relaxed text-[#5A6174] dark:text-[#8E95A8]">
            <li className="flex items-start gap-2.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2563EB] dark:text-[#60A5FA]" aria-hidden="true" />
              <span>
                <strong className="font-semibold text-[#111318] dark:text-[#ECEEF4]">
                  Automatic Same-Origin Proxy for Non-CORS Servers:
                </strong>{' '}
                SignalDeck tries direct loading first. If a remote video server omits{' '}
                <code className="font-mono text-[11px] text-[#111318] dark:text-[#CBD1E0]">
                  Access-Control-Allow-Origin
                </code>{' '}
                headers or links to a public page with an embedded HTML5 video, SignalDeck
                automatically streams it through its same-origin proxy so{' '}
                <code className="font-mono text-[11px]">captureStream()</code> works cleanly.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2563EB] dark:text-[#60A5FA]" aria-hidden="true" />
              <span>
                <strong className="font-semibold text-[#111318] dark:text-[#ECEEF4]">
                  Embedded Streaming Platforms:
                </strong>{' '}
                Webpages using DRM or proprietary iframe players (such as YouTube, Netflix, or Vimeo)
                cannot be loaded as raw HTML5 video streams.
              </span>
            </li>
            <li className="flex items-start gap-2.5">
              <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#2563EB] dark:text-[#60A5FA]" aria-hidden="true" />
              <span>
                <strong className="font-semibold text-[#111318] dark:text-[#ECEEF4]">
                  Cursor-Free Capture &amp; Resilience:
                </strong>{' '}
                Moving your mouse over the player never appears in the file. Network drops or
                buffering automatically pause capture and resume into the same single recording once
                playback advances again.
              </span>
            </li>
          </ul>
        </div>
      </div>
    </section>
  );
}
