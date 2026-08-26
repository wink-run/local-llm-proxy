import React from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App';

if (typeof window !== 'undefined' && window.electronAPI) {
  document.documentElement.classList.add('tb-electron');
}

createRoot(document.getElementById('root')).render(<App />);
