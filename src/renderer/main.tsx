import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { HighlightWorkers } from './diff/HighlightWorkers';
import './diff/codeThemes';
import { applyCachedAppTheme } from './state/settings';
import './styles.css';

applyCachedAppTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HighlightWorkers>
      <App />
    </HighlightWorkers>
  </StrictMode>,
);
