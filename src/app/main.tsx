import './globals.css';
import './i18n';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import i18n from './i18n';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

document.documentElement.lang = i18n.resolvedLanguage ?? 'en';

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
