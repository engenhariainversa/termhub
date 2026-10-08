// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DataExportStatus } from '../lib/types';

const { accountApi } = vi.hoisted(() => ({
  accountApi: {
    dataExport: vi.fn<() => Promise<DataExportStatus>>(),
    requestDataExport: vi.fn<() => Promise<DataExportStatus>>(),
    dataExportUrl: (id: string) => `/api/account/export/${id}/download`,
  },
}));

vi.mock('../lib/api', () => ({
  api: { account: accountApi },
  ApiError: class ApiError extends Error {},
}));

import { ApiError } from '../lib/api';
import { DataExportSection } from './DataExportSection';

const DAY = 24 * 60 * 60 * 1000;
const iso = (offset: number) => new Date(Date.now() + offset).toISOString();

describe('DataExportSection', () => {
  beforeEach(() => {
    accountApi.dataExport.mockReset();
    accountApi.requestDataExport.mockReset();
  });
  afterEach(cleanup);

  it('asks for an export and says it is being prepared', async () => {
    accountApi.dataExport.mockResolvedValue({ export: null, next_allowed_at: null });
    accountApi.requestDataExport.mockResolvedValue({
      export: { id: 'x1', status: 'pending', bytes: null, created_at: iso(0), completed_at: null, expires_at: null },
      next_allowed_at: iso(DAY),
    });
    render(<DataExportSection />);
    const button = await screen.findByRole('button', { name: 'Exportar meus dados' });
    await vi.waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByText('Preparando o arquivo… Você recebe um e-mail quando ele ficar pronto.')).toBeInTheDocument();
    expect(accountApi.requestDataExport).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('button', { name: 'Exportar meus dados' })).not.toBeInTheDocument();
  });

  it('offers the ready archive and holds the button until the day is over', async () => {
    accountApi.dataExport.mockResolvedValue({
      export: { id: 'x1', status: 'ready', bytes: 2048, created_at: iso(-1000), completed_at: iso(0), expires_at: iso(7 * DAY) },
      next_allowed_at: iso(DAY),
    });
    render(<DataExportSection />);
    const link = await screen.findByRole('link', { name: /Baixar \(2 KB\)/ });
    expect(link).toHaveAttribute('href', '/api/account/export/x1/download');
    expect(screen.getByRole('button', { name: 'Exportar meus dados' })).toBeDisabled();
    expect(screen.getByText(/Você pode pedir outra exportação a partir de/)).toBeInTheDocument();
  });

  it("shows the server's refusal", async () => {
    accountApi.dataExport.mockResolvedValue({ export: null, next_allowed_at: null });
    accountApi.requestDataExport.mockRejectedValue(new ApiError('Você pode pedir uma exportação por dia.'));
    render(<DataExportSection />);
    const button = await screen.findByRole('button', { name: 'Exportar meus dados' });
    await vi.waitFor(() => expect(button).toBeEnabled());
    fireEvent.click(button);
    expect(await screen.findByRole('alert')).toHaveTextContent('Você pode pedir uma exportação por dia.');
  });
});
