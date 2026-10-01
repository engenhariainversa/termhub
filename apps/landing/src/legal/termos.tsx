import React from 'react';
import ReactDOM from 'react-dom/client';
import doc from '../../legal/termos-de-uso.md?legal';
import { LegalPage } from './LegalPage';
import '../index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <LegalPage slug="termos" doc={doc} />
  </React.StrictMode>,
);
