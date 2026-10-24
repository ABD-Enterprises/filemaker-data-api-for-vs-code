import type { Metadata } from 'next';
import type { JSX, ReactNode } from 'react';
import './styles.css';

export const metadata: Metadata = {
  title: 'FM Web Runtime',
  description: 'Generated runtime for FileMaker web layouts'
};

export default function RootLayout({ children }: { children: ReactNode }): JSX.Element {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
