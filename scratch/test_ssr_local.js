import React from 'react';
import ReactDOMServer from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import Dashboard from '../src/pages/Dashboard';

// Mock localStorage and window properties
global.localStorage = {
  getItem: (key) => null,
  setItem: (key, val) => {},
  removeItem: (key) => {}
};

try {
  console.log("Starting SSR render test with MemoryRouter...");
  const html = ReactDOMServer.renderToString(
    React.createElement(MemoryRouter, null, 
      React.createElement(Dashboard, null)
    )
  );
  console.log("SSR render successful! Length of HTML:", html.length);
} catch (error) {
  console.error("SSR render failed with error:", error);
}
