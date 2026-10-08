import { setLocale } from '@/i18n';
import { stateLine } from './state-line';

const tab = (p: Partial<Parameters<typeof stateLine>[0]>) => stateLine({ state: null, background: false, finished: false, needs_you: false, activity: null, ...p });

it('a working tab says so, with the tool it runs', () => {
  expect(tab({ state: 'working', activity: 'Bash' })).toBe('Trabalhando · Bash');
  expect(tab({ state: 'working' })).toBe('Trabalhando');
});

it('a working tab that only waits on its own background work', () => {
  expect(tab({ state: 'working', background: true, activity: 'Bash' })).toBe('Em segundo plano');
});

it('a tab that needs the person', () => {
  expect(tab({ state: 'waiting_permission', needs_you: true })).toBe('Esperando você');
  expect(tab({ state: 'waiting_input' })).toBe('Esperando você');
});

it('a tab that finished with a report and asks nothing is Concluído, never Esperando você (TER-972)', () => {
  expect(tab({ state: 'idle', finished: true })).toBe('Concluído');
  expect(tab({ state: 'idle', finished: true, needs_you: true })).toBe('Esperando você');
});

it('idle or no state is Parado; error is Erro', () => {
  expect(tab({ state: 'idle' })).toBe('Parado');
  expect(tab({ state: null })).toBe('Parado');
  expect(tab({ state: 'error' })).toBe('Erro');
});

it('an expired login, the trust dialog and a blocked run say what they are (TER-1046)', () => {
  expect(tab({ state: 'error', auth_required: true, needs_you: true })).toBe('Login expirado: rode /login');
  expect(tab({ state: 'waiting_input', trust_prompt: true, needs_you: true })).toBe('Pergunta se a pasta é confiável');
  expect(tab({ state: 'idle', blocked: true })).toBe('Bloqueado');
});

describe('in English', () => {
  beforeEach(() => setLocale('en'));
  afterEach(() => setLocale(null));

  it('says the state in English', () => {
    expect(tab({ state: 'working', activity: 'Bash' })).toBe('Working · Bash');
    expect(tab({ state: 'waiting_input' })).toBe('Waiting for you');
    expect(tab({ state: 'idle' })).toBe('Idle');
  });
});
