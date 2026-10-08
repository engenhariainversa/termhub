import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrandPage } from './BrandPage';
import '@fontsource/jetbrains-mono/400.css';
import '@fontsource/jetbrains-mono/700.css';
import '../index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrandPage />
  </React.StrictMode>,
);
