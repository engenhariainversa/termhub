import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { msg } from '../i18n/index.js';
import { HttpError, applyErrorHandler, notFound, sendError } from './errors.js';

async function app(user: { locale: string | null } | null = null) {
  const a = Fastify();
  a.decorateRequest('user', null);
  a.addHook('onRequest', async (request) => {
    (request as unknown as { user: unknown }).user = user;
  });
  applyErrorHandler(a);
  a.get('/plain', async () => {
    throw notFound('Projeto não encontrado');
  });
  a.get('/vars', async () => {
    throw new HttpError(409, msg('O agente já está na versão {{version}}', { version: '1.2.3' }), 'CONFLICT');
  });
  a.get('/zod', async () => z.object({ a: z.string() }).parse({}));
  a.get('/boom', async () => {
    throw new Error('segredo interno');
  });
  a.get('/direct', async (request, reply) => sendError(request, reply, 409, 'Esse apelido já é de outra pessoa', 'NICKNAME_TAKEN'));
  await a.ready();
  return a;
}

describe('applyErrorHandler', () => {
  it('answers in pt-BR by default, with the code unchanged', async () => {
    const a = await app();
    const r = await a.inject({ url: '/plain' });
    expect(r.statusCode).toBe(404);
    expect(r.json()).toEqual({ error: 'Projeto não encontrado', code: 'NOT_FOUND' });
    expect((await a.inject({ url: '/vars' })).json()).toEqual({ error: 'O agente já está na versão 1.2.3', code: 'CONFLICT' });
  });

  it('answers in English for an English Accept-Language', async () => {
    const a = await app();
    const headers = { 'accept-language': 'en-US,en;q=0.9' };
    expect((await a.inject({ url: '/plain', headers })).json()).toEqual({ error: 'Project not found', code: 'NOT_FOUND' });
    expect((await a.inject({ url: '/vars', headers })).json()).toEqual({ error: 'The agent is already on version 1.2.3', code: 'CONFLICT' });
    const zod = (await a.inject({ url: '/zod', headers })).json();
    expect(zod.error).toBe('Invalid data');
    expect(zod.code).toBe('VALIDATION');
    expect((await a.inject({ url: '/boom', headers })).json()).toEqual({ error: 'Internal error', code: 'ERROR' });
    expect((await a.inject({ url: '/direct', headers })).json()).toEqual({ error: 'That nickname belongs to someone else', code: 'NICKNAME_TAKEN' });
  });

  it("follows the signed-in user's choice over the header", async () => {
    const en = await app({ locale: 'en' });
    expect((await en.inject({ url: '/plain', headers: { 'accept-language': 'pt-BR' } })).json().error).toBe('Project not found');
    const pt = await app({ locale: 'pt-BR' });
    expect((await pt.inject({ url: '/plain', headers: { 'accept-language': 'en' } })).json().error).toBe('Projeto não encontrado');
  });

  it('keeps the pt-BR text in Error.message', () => {
    expect(new HttpError(409, msg('O agente já está na versão {{version}}', { version: '1' })).message).toBe('O agente já está na versão 1');
  });
});
