import { useEffect, useState } from 'react';
import { getSettings } from './api/client.ts';
import { Async, useAsync } from './hooks.tsx';
import { Archived } from './pages/Archived.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Experiment } from './pages/Experiment.tsx';
import { Files } from './pages/Files.tsx';
import { Repositories } from './pages/Repositories.tsx';
import { SettingsPage } from './pages/Settings.tsx';
import { Upload } from './pages/Upload.tsx';

const PAGES = ['dashboard', 'files', 'upload', 'archived', 'experiment', 'repositories', 'settings'] as const;
type Page = (typeof PAGES)[number];
const TITLES: Record<Page, string> = {
  dashboard: 'Dashboard', files: 'Files', upload: 'Upload', archived: 'Archived', experiment: 'Storage Experiment', repositories: 'Repositories', settings: 'Settings',
};
const current = (): Page => {
  const h = window.location.hash.replace(/^#\//, '') as Page;
  return PAGES.includes(h) ? h : 'dashboard';
};

export function App() {
  const [page, setPage] = useState<Page>(current());
  useEffect(() => {
    const on = () => setPage(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const settings = useAsync(getSettings);

  return (
    <div className="app">
      <header>
        <h1>GitVault <span className="muted">Git-backed storage</span></h1>
        <nav>{PAGES.map((p) => <a key={p} href={`#/${p}`} className={p === page ? 'active' : ''}>{TITLES[p]}</a>)}</nav>
      </header>
      <Async state={settings}>{(s) => (
        <>
          {s.backend === 'github'
            ? <div className="banner banner-gh">Connected to GitHub. Repository storage is subject to GitHub's limits and policies.</div>
            : <div className="banner">Local mode: repositories are simulated on disk. No GitHub account needed.</div>}
          <main>
            {page === 'dashboard' && <Dashboard backend={s.backend} />}
            {page === 'files' && <Files backend={s.backend} />}
            {page === 'upload' && <Upload />}
            {page === 'archived' && <Archived backend={s.backend} />}
            {page === 'experiment' && <Experiment settings={s} />}
            {page === 'repositories' && <Repositories settings={s} />}
            {page === 'settings' && <SettingsPage settings={s} />}
          </main>
        </>
      )}</Async>
    </div>
  );
}
