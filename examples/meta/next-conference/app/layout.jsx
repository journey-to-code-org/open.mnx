import './globals.css';

export const metadata = { title: 'WebConf 2026', description: 'A conference schedule built with Next.js and mnx components.' };

export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <a href="/" className="brand">WebConf 2026</a>
          <span className="muted">Lisbon · Thu–Fri</span>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
