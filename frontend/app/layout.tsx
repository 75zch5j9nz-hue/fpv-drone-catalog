'use client';

import './globals.css';
import { ReactNode, useEffect } from 'react';

export default function RootLayout({ children }: { children: ReactNode }) {
  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        navigator.serviceWorker.addEventListener('message', (e) => {
          if (e.data?.type === 'SYNC_COMPLETE') {
            (window as unknown as Record<string, (...a: unknown[]) => unknown>).__fpvSyncComplete?.(e.data.remaining);
          }
        });
        void reg;
      }).catch(() => {});
    }
  }, []);

  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        <meta name="theme-color" content="#60a0f0" />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="FPV Fleet" />
        <link rel="manifest" href="/manifest.webmanifest" />
        <link rel="icon" href="/icon-192.png" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <title>FPV Drone Catalog</title>
        <meta name="description" content="Self-hosted FPV drone fleet manager — Betaflight backups, checklists, flight logs" />
      </head>
      <body>{children}</body>
    </html>
  );
}
