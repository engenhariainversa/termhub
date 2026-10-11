import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from '../i18n';

/**
 * The public city's last line of defence. React unmounts the whole tree for an error nothing
 * catches, which a visitor sees as a blank page; the likeliest cause here is a deploy that changed
 * the snapshot's shape under an open page, and a reload (which fetches the new bundle) is what fixes
 * it — so that is what this offers. Local to the bundle: it may not import the app's components.
 */
export class CityErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('public city failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <CityFailed />;
  }
}

function CityFailed() {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 px-4 py-8 text-center">
      <p className="text-sm text-fg-muted">{t('Algo mudou por aqui. Recarregue a página.')}</p>
      <button type="button" className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover" onClick={() => window.location.reload()}>
        {t('Recarregar')}
      </button>
    </div>
  );
}
