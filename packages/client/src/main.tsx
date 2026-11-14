/// <reference types="vite/client" />
import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import './style.css';
import { ReactionPrototype } from './ReactionPrototype.tsx';

// PROTOTYPE：dev 下 ?prototype=reaction 打开表态原型；生产构建里 import.meta.env.DEV 为 false，永远走 App
const prototype = import.meta.env.DEV && new URLSearchParams(location.search).get('prototype') === 'reaction';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {prototype ? <ReactionPrototype /> : <App />}
  </React.StrictMode>,
);
