import './globals.css';
import type { Metadata, Viewport } from 'next';
import { ReactNode } from 'react';

export const metadata: Metadata = {
  title: 'FPV Drone Catalog',
  description: 'Self-hosted FPV drone fleet manager — Betaflight backups, checklists, flight logs',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'FPV Fleet',
  },
  icons: {
    icon: '/icon-192.png',
    apple: '/apple-touch-icon.png',
  },
};

export const viewport: Viewport = {
  themeColor: '#60a0f0',
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="mobile-web-app-capable" content="yes" />
      </head>
      <body>
        {children}
        <script
          dangerouslySetInnerHTML={{
            __html: `
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then((reg) => {
      // Listen for sync-complete messages from SW
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'SYNC_COMPLETE') {
          window.__fpvSyncComplete?.(e.data.remaining);
        }
      });
    }).catch(() => {});
  });
}
`,
          }}
        />
      </body>
    </html>
  );
}
