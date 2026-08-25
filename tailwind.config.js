'use strict';

module.exports = {
  content: [
    './renderer/index.html',
    './renderer/app.js',
    './renderer/creator-engine.js',
  ],
  safelist: [
    'hidden',
    'flex',
    'border-blue',
    'text-blue',
    'border-border',
    'text-muted',
  ],
  theme: {
    extend: {
      colors: {
        base: '#08090b',
        surface: '#111216',
        panel: '#17181d',
        border: '#2a2b31',
        muted: '#787a82',
        dim: '#a1a3aa',
        text: '#f5f5f7',
        accent: '#0a84ff',
        blue: '#0a84ff',
        red: '#ff453a',
        yellow: '#ffd60a',
        green: '#30d158',
        cyan: '#64d2ff',
      },
    },
  },
};
