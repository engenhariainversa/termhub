import React from 'react';
import ReactDOM from 'react-dom/client';
import doc from '../../legal/politica-de-privacidade.md?legal';
import { LegalPage } from './LegalPage';
import '../index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LegalPage slug="privacidade" doc={doc} />
  </React.StrictMode>,
);
