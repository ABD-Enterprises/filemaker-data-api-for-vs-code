import Link from 'next/link';
import type { JSX } from 'react';

export default function HomePage(): JSX.Element {
  return (
    <main className="runtime-home">
      <h1>FM Web Runtime Template</h1>
      <p>Open a generated layout page to preview runtime rendering.</p>
      <Link href="/layouts/example">Open Example Layout</Link>
    </main>
  );
}
