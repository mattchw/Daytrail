import React from 'react';
import {createRoot} from 'react-dom/client';
import App from './App';
import './styles.css';
import './planner.css';
import './mobile-planner.css';
import {registerOfflineShell} from './offline/pwa';
void registerOfflineShell(import.meta.env.PROD);
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
