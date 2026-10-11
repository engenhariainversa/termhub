import { useEffect, useRef } from 'react';
import { i18n } from '../i18n';
import { useData } from '../lib/data';
import { useMonitor } from '../lib/monitor';
import { needsYouText, tabNeedsYou } from '../lib/needs-you';
import { useToast } from '../lib/toast';
import { isTabOnScreen } from '../lib/visible-tabs';

/**
 * Turns "a tab started needing you" into a toast (top right), except for a tab the person
 * is already looking at. The toast goes away by itself once the tab no longer needs you
 * (stops waiting, or the person focuses it — see useMarkSeenOnFocus).
 */
export function NeedsYouToasts() {
  const { items, onNeedsYou } = useMonitor();
  const { projects } = useData();
  const { show, dismiss } = useToast();
  const projectsRef = useRef(projects);
  projectsRef.current = projects;

  useEffect(
    () =>
      onNeedsYou((tab, projectId) => {
        if (document.visibilityState === 'visible' && isTabOnScreen(tab.id)) return;
        const project = projectsRef.current.find((p) => p.id === projectId);
        show({
          id: tab.id,
          title: `${project?.name ?? i18n.t('Projeto')} › ${tab.name}`,
          body: needsYouText(tab),
          href: `/projects/${projectId}?tab=${tab.id}`,
        });
      }),
    [onNeedsYou, show],
  );

  useEffect(() => {
    for (const { tab } of items) if (!tabNeedsYou(tab)) dismiss(tab.id);
  }, [items, dismiss]);

  return null;
}
