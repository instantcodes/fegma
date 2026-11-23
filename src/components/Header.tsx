import { Moon, Radio, Sun } from 'lucide-react';

interface HeaderProps {
  theme: 'dark' | 'light';
  onToggleTheme: () => void;
}

export function Header({ theme, onToggleTheme }: HeaderProps) {
  return (
    <header className="sticky top-0 z-30 border-b border-[#E1E4EC] bg-white/95 backdrop-blur-sm dark:border-[#252936] dark:bg-[#0D0F16]/95">
      <div className="mx-auto flex h-16 max-w-[1360px] items-center justify-between gap-8 px-4 sm:px-6 lg:px-8">
        {/* Zone 1: Single-line Brand wordmark */}
        <a
          href="#recorder"
          className="flex shrink-0 items-center gap-2.5 whitespace-nowrap font-display text-lg font-bold tracking-tight text-[#111318] transition-opacity hover:opacity-85 dark:text-[#ECEEF4]"
        >
          <Radio className="h-5 w-5 text-[#DC2626]" aria-hidden="true" />
          <span>SignalDeck</span>
        </a>

        {/* Zone 2: Clean single-line navigation links */}
        <nav
          aria-label="Primary"
          className="hidden items-center gap-7 text-sm font-medium text-[#5A6174] md:flex dark:text-[#8E95A8]"
        >
          <a
            href="#recorder"
            className="shrink-0 whitespace-nowrap py-1 transition-colors hover:text-[#111318] hover:underline hover:underline-offset-4 dark:hover:text-[#ECEEF4]"
          >
            Recorder
          </a>
          <a
            href="#preview"
            className="shrink-0 whitespace-nowrap py-1 transition-colors hover:text-[#111318] hover:underline hover:underline-offset-4 dark:hover:text-[#ECEEF4]"
          >
            Final Preview
          </a>
          <a
            href="#compatibility"
            className="shrink-0 whitespace-nowrap py-1 transition-colors hover:text-[#111318] hover:underline hover:underline-offset-4 dark:hover:text-[#ECEEF4]"
          >
            Compatibility
          </a>
        </nav>

        {/* Zone 3: Primary header utility action (Dark / Light toggle) */}
        <div className="flex shrink-0 items-center">
          <button
            type="button"
            onClick={onToggleTheme}
            aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
            className="inline-flex h-10 shrink-0 cursor-pointer items-center gap-2 whitespace-nowrap rounded-md border border-[#E1E4EC] bg-[#F5F6F9] px-3.5 text-xs font-medium text-[#111318] transition-colors duration-150 hover:bg-[#EAECEF] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#2563EB] dark:border-[#2A2F3E] dark:bg-[#161924] dark:text-[#ECEEF4] dark:hover:bg-[#1E2230]"
          >
            {theme === 'dark' ? (
              <>
                <Sun className="h-4 w-4 text-amber-400" aria-hidden="true" />
                <span>Light Mode</span>
              </>
            ) : (
              <>
                <Moon className="h-4 w-4 text-[#2563EB]" aria-hidden="true" />
                <span>Dark Mode</span>
              </>
            )}
          </button>
        </div>
      </div>
    </header>
  );
}
