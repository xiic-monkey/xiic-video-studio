import React from 'react';
import ReactDOM from 'react-dom/client';
import { StudioApp } from './app/StudioApp';
import { ErrorBoundary, installGlobalErrorOverlay } from './app/ErrorBoundary';
import './styles/studio.css';

installGlobalErrorOverlay();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <StudioApp />
    </ErrorBoundary>
  </React.StrictMode>,
);
