import './globals.css';
import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { App } from './App';

const root = document.getElementById('root');
if (!root) throw new Error('root element not found');

document.documentElement.lang = 'en';

ReactDOM.createRoot(root).render(
  <React.StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </React.StrictMode>
);
