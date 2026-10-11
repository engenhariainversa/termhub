import { setLocale, t } from '@/i18n';
import { activeGrantsLabel, endedAtLabel, GRANT_STATE_LABEL, grantOriginLabel, grantTitleLabel, standingKindLabel } from './labels';

afterEach(() => setLocale(null));

it('names grants in English, the standing kinds included', () => {
  setLocale('en');
  expect(activeGrantsLabel(1)).toBe('1 active permission');
  expect(activeGrantsLabel(3)).toBe('3 active permissions');
  expect(grantTitleLabel({ kind: 'tab', tab_name: 'api', project_name: 'App', tool: 'terminal', scope: null })).toBe('Tab api · keys and shell');
  expect(grantTitleLabel({ kind: 'project', tab_name: null, project_name: 'App', tool: null, scope: 'all' })).toBe('Everything in project App');
  expect(grantTitleLabel({ kind: 'standing', tab_name: null, project_name: 'App', standing_kind: 'close_tab' })).toBe('Close idle tabs in project App · no time limit');
  expect(standingKindLabel('start_agent')).toBe('Start agents');
  expect(grantOriginLabel({ kind: 'project', conversation_id: 'c1', conversation_project_name: 'termhub', conversation_archived: true })).toBe(
    'termhub project chat · conversation ended',
  );
  expect(t(GRANT_STATE_LABEL.revoked)).toBe('Revoked');
  expect(endedAtLabel(new Date(2026, 8, 5, 7, 3).toISOString())).toMatch(/^09\/05\/2026 07:03\sAM$/);
});
