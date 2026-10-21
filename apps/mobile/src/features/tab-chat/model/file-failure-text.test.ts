import { TAB_FILE_MAX_BYTES } from '@termhub/mobile-api';
import { ApiError } from '@/services/api/errors';
import { tabFileFailureText, tabFileTooLarge } from './file-failure-text';

it('a 413 says the limit, whether the server or the proxy refused it', () => {
  const proxy = ApiError.fromBody(413, {}, '<html><body>413 Request Entity Too Large</body></html>');
  expect(tabFileFailureText(proxy)).toBe('Arquivo grande demais: o limite numa sessão é 20 MB.');
  expect(tabFileFailureText(new ApiError(413, 'ERROR', 'Arquivo maior que 20 MB'))).toBe('Arquivo grande demais: o limite numa sessão é 20 MB.');
});

it('the server’s own refusal is shown as it came', () => {
  expect(tabFileFailureText(new ApiError(503, 'AGENT_OFFLINE', 'Agente desconectado'))).toBe('Não foi possível enviar o arquivo: Agente desconectado');
});

it('a body that is not the server’s names only the status', () => {
  expect(tabFileFailureText(ApiError.fromBody(502, {}, '<html>Bad Gateway</html>'))).toBe('Não foi possível enviar o arquivo (erro 502).');
});

it('no answer at all reads as no connection', () => {
  expect(tabFileFailureText(new Error('Network request failed'))).toBe('Não foi possível enviar o arquivo: sem conexão com o servidor.');
});

it('checks the size before the upload; an unknown size goes through', () => {
  expect(tabFileTooLarge(TAB_FILE_MAX_BYTES)).toBe(false);
  expect(tabFileTooLarge(TAB_FILE_MAX_BYTES + 1)).toBe(true);
  expect(tabFileTooLarge(null)).toBe(false);
});
