import { describe, expect, it } from 'vitest';
import { confirmationText, deviceRequestText, replyText, tabQuestionText } from './push-text.js';

describe('push texts', () => {
  it('names the project, tab and machine and never anything else', () => {
    expect(confirmationText({ projectName: 'termhub', tabName: 'api', machineName: 'jarvis' })).toEqual({ title: 'termhub precisa de você', body: 'O chat do projeto termhub pediu confirmação para agir na aba api (jarvis).' });
    expect(confirmationText({ projectName: null, tabName: 'api', machineName: 'jarvis' }).body).toBe('O chat geral pediu confirmação para agir na aba api (jarvis).');
    expect(confirmationText({ projectName: 'termhub', tabName: null, machineName: null }).body).toBe('O chat do projeto termhub pediu sua confirmação.');
    expect(replyText({ projectName: 'termhub', tabName: null, machineName: null })).toEqual({ title: 'Resposta pronta em termhub', body: 'O chat do projeto termhub terminou de responder.' });
    expect(replyText({ projectName: null, tabName: null, machineName: null })).toEqual({ title: 'Resposta pronta', body: 'O chat geral terminou de responder.' });
    expect(deviceRequestText({ model: 'iPhone 15', city: 'São Paulo', country: 'BR' })).toEqual({ title: 'Novo aparelho pede acesso', body: 'iPhone 15 (São Paulo) pediu acesso à sua conta. Confira o código e aprove ou recuse na web.' });
    expect(deviceRequestText({ model: 'Pixel 8', city: null, country: null }).body).toMatch(/^Pixel 8 pediu acesso/);
  });

  it('a tab question names the project and the tab, never the question', () => {
    expect(tabQuestionText({ projectName: 'termhub', tabName: 'api', machineName: null }, 'choice')).toEqual({ title: 'termhub precisa de você', body: 'A aba api fez uma pergunta.' });
    expect(tabQuestionText({ projectName: 'termhub', tabName: 'api', machineName: null }, 'permission')).toEqual({ title: 'termhub precisa de você', body: 'A aba api pede permissão para continuar.' });
    expect(tabQuestionText({ projectName: null, tabName: null, machineName: null }, 'choice')).toEqual({ title: 'termhub precisa de você', body: 'Uma aba fez uma pergunta.' });
  });
});
