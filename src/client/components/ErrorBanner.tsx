interface ErrorBannerProps {
  count: number;
  onShow(): void;
}

/** Shown on every page while sync errors are open. */
export function ErrorBanner({ count, onShow }: ErrorBannerProps) {
  if (count === 0) {
    return null;
  }
  return (
    <div role="alert" className="mb-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3">
      <p className="text-sm font-medium text-red-800">
        {count} sync {count === 1 ? 'error needs' : 'errors need'} attention
      </p>
      <button type="button" onClick={onShow} className="rounded-lg border border-red-300 bg-white px-3 py-1.5 text-sm font-medium text-red-800">
        Show errors
      </button>
    </div>
  );
}
