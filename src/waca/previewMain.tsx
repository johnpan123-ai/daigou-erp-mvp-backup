import React from 'react';
import { createRoot } from 'react-dom/client';
import { WacaPreview } from './WacaPreview';
import './preview.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><WacaPreview /></React.StrictMode>);
