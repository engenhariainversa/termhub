import React from 'react';
import ReactDOM from 'react-dom/client';
// first: the language (stored choice, else the browser's) is set before anything renders
import '../i18n';
import { CityErrorBoundary } from './CityErrorBoundary';
import { CityPage } from './CityPage';
import { nicknameFromPath } from './url';
import './city.css';

const nickname = nicknameFromPath(location.pathname);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <CityErrorBoundary>
      <CityPage nickname={nickname} />
    </CityErrorBoundary>
  </React.StrictMode>,
);
