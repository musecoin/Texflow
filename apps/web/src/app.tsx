import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { session, get, login, logout, connectEvents, ApiError, isNative, getServer, setServer } from './api.ts';
import { t, locale, setLocale } from './i18n.ts';
import { LiveContext, ToastHost, Button, Field, Input, Loading, ErrorBox, errorText } from './ui.tsx';
import { Home } from './pages/home.tsx';
import { OrdersPage, OrderDetail } from './pages/orders.tsx';
import { ModelsPage, ModelDetail } from './pages/models.tsx';
import { InventoryPage, RollDetail, ScanPage } from './pages/inventory.tsx';
import { WorkOrdersPage, WorkOrderDetail } from './pages/workOrders.tsx';
import { LedgerPage, AuditPage } from './pages/ledger.tsx';
import { RoadmapPage } from './pages/roadmap.tsx';
import { SECTIONS, nextPhase, sectionOf } from './navigation.ts';

// ---------------------------------------------------------------- routing (hash based; works in Capacitor file/webview contexts)
export function useRoute(): string[] {
  const [h, setH] = useState(location.hash);
  useEffect(() => { const f = () => setH(location.hash); window.addEventListener('hashchange', f); return () => window.removeEventListener('hashchange', f); }, []);
  return h.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean);
}
export const go = (path: string) => { location.hash = '#/' + path.replace(/^\//, ''); };

export interface Me { user: { id: string; email: string; displayName: string }; organization: { id: string; code: string; name: string; baseCurrency: string; isDemo: boolean };
  roles: { code: string; name: string }[]; factories: { id: string; code: string; name: string }[]; permissions: string[] }
export const MeContext = createContext<Me | null>(null);
export const useMe = () => useContext(MeContext)!;
export const useCan = () => { const me = useMe(); return (p: string) => me.permissions.includes(p); };

// bottom navigation on phones: the operator's four most used screens
const MOBILE_NAV: { label: string; path: string; icon: string; perm: string }[] = [
  { label: 'nav.dashboard', path: '', icon: '▦', perm: 'org.read' },
  { label: 'nav.inventory', path: 'inventory', icon: '◫', perm: 'inventory.read' },
  { label: 'nav.workOrders', path: 'work-orders', icon: '⚙', perm: 'workorder.read' },
  { label: 'nav.scan', path: 'scan', icon: '⌗', perm: 'inventory.read' },
];

/** Grouped menu following the "Fabrika Kontrol Merkezi" design; shared by the desktop sidebar and the phone menu sheet. */
function SectionNav({ route, onNavigate }: { route: string[]; onNavigate?: () => void }) {
  const can = useCan();
  const current = sectionOf(route);
  // accordion: one section open at a time, following the current page
  const [open, setOpen] = useState<string | null>(current);
  useEffect(() => { setOpen(current); }, [current]);
  const toggle = (k: string) => setOpen((o) => (o === k ? null : k));
  const linkActive = (sKey: string, p: string) => sKey === current && (route[0] === p || (p === 'inventory' && route[0] === 'rolls'));
  const en = locale === 'en';
  return (
    <ul className="flex flex-col gap-0.5">
      {SECTIONS.map((s) => {
        const name = en ? s.labelEn : s.label;
        if (s.path !== undefined) {
          if (s.perm && !can(s.perm)) return null;
          const act = current === s.key && route[0] !== 'plan';
          return <li key={s.key}><a href={'#/' + s.path} onClick={onNavigate} aria-current={act ? 'page' : undefined}
            className={clsx('flex items-center gap-3 rounded-lg px-3 min-h-11 text-sm font-semibold', act ? 'bg-brand-700 text-white dark:bg-brand-400 dark:text-onbrand dark:glow' : 'text-ink hover:bg-subtle')}>
            <span className="w-5 text-center" aria-hidden>{s.icon}</span>{name}</a></li>;
        }
        const links = s.links.filter((l) => can(l.perm));
        const isOpen = open === s.key;
        const np = nextPhase(s);
        return (
          <li key={s.key}>
            <button type="button" onClick={() => toggle(s.key)} aria-expanded={isOpen}
              className={clsx('w-full flex items-center gap-3 rounded-lg px-3 min-h-11 text-sm font-semibold text-left', current === s.key ? 'text-brand-700 dark:text-brand-300' : 'text-ink', 'hover:bg-subtle')}>
              <span className="w-5 text-center" aria-hidden>{s.icon}</span>
              <span className="flex-1">{name}</span>
              {!links.length && np && <span className="text-[10px] font-semibold rounded px-1.5 py-0.5 bg-subtle text-muted">Faz {np}</span>}
              <span aria-hidden className={clsx('text-xs text-muted transition-transform', isOpen && 'rotate-90')}>›</span>
            </button>
            {isOpen && (
              <ul className="ml-5 pl-3 border-l border-line flex flex-col gap-0.5 py-1">
                {links.map((l) => {
                  const act = linkActive(s.key, l.path);
                  return <li key={l.label}><a href={'#/' + l.path} onClick={onNavigate} aria-current={act ? 'page' : undefined}
                    className={clsx('flex items-center rounded-md px-3 min-h-10 text-sm', act ? 'bg-brand-700 text-white dark:bg-brand-400 dark:text-onbrand' : 'text-ink hover:bg-subtle')}>{l.label}</a></li>;
                })}
                {s.planned.map((p) => (
                  <li key={p.label}><a href={'#/plan/' + s.key} onClick={onNavigate} title={p.detail}
                    className={clsx('flex items-center gap-2 rounded-md px-3 min-h-9 text-[13px] text-muted hover:bg-subtle', route[0] === 'plan' && route[1] === s.key && 'bg-subtle')}>
                    <span className="flex-1">{p.label}</span><span className="text-[10px] opacity-80">Faz {p.phase}</span></a></li>
                ))}
              </ul>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function LoginScreen() {
  const [org, setOrg] = useState('DEMO'); const [email, setEmail] = useState(''); const [pw, setPw] = useState('');
  const [err, setErr] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const native = isNative(); const [server, setSrv] = useState(getServer());
  return (
    <main className="min-h-dvh grid place-items-center p-4 bg-canvas">
      <form className="w-full max-w-sm rounded-2xl border border-line bg-surface p-6 shadow-sm flex flex-col gap-4"
        onSubmit={async (e) => { e.preventDefault(); setBusy(true); setErr(null); try { if (native) setServer(server); await login(org.trim(), email.trim(), pw); } catch (x) { setErr(errorText(x)); } finally { setBusy(false); } }}>
        <div className="flex items-center gap-3"><Logo /><div><div className="font-bold text-ink text-lg">{t('app.name')}</div><div className="text-xs text-muted">{t('app.tagline')}</div></div></div>
        <h1 className="text-lg font-semibold text-ink">{t('login.title')}</h1>
        {native && <Field label="Sunucu adresi" hint="TEXFLOW API'nin çalıştığı adres, örn. https://texflow.firmaniz.com veya http://192.168.1.20:8080"><Input name="server" type="url" inputMode="url" autoCapitalize="none" value={server} onChange={(e) => setSrv(e.target.value)} required placeholder="https://" /></Field>}
        <Field label={t('login.org')}><Input name="org" value={org} onChange={(e) => setOrg(e.target.value)} autoCapitalize="characters" required /></Field>
        <Field label={t('login.email')}><Input name="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label={t('login.password')}><Input name="password" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} required /></Field>
        {err && <div role="alert" className="text-sm text-red-700 dark:text-red-300">{err}</div>}
        <Button type="submit" loading={busy}>{t('login.submit')}</Button>
        <p className="text-xs text-muted">{t('login.demoHint')}</p>
      </form>
    </main>
  );
}

function Logo() { return <div className="size-9 rounded-lg bg-brand-600 text-white grid place-items-center font-black" aria-hidden>T</div>; }

// light / dark theme: dark default (factory floor); choice remembered per device
const readTheme = (): 'dark' | 'light' => { try { return localStorage.getItem('texflow.theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } };
const applyTheme = (th: 'dark' | 'light') => { if (th === 'light') document.documentElement.setAttribute('data-theme', 'light'); else document.documentElement.removeAttribute('data-theme'); };
applyTheme(readTheme());
function ThemeToggle() {
  const [th, setTh] = useState(readTheme());
  const next = th === 'dark' ? 'light' : 'dark';
  return <button className="text-xs text-muted min-h-10 min-w-10 px-2 rounded-lg hover:bg-subtle" aria-label={next === 'light' ? 'Açık temaya geç' : 'Koyu temaya geç'} title={next === 'light' ? 'Açık tema' : 'Koyu tema'}
    onClick={() => { applyTheme(next); try { localStorage.setItem('texflow.theme', next); } catch { /* ignore */ } setTh(next); }}>{th === 'dark' ? '☀' : '☾'}</button>;
}

function GlobalSearch() {
  const [q, setQ] = useState(''); const [res, setRes] = useState<{ label: string; path: string }[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) { setRes([]); return; }
    const h = setTimeout(async () => {
      const enc = encodeURIComponent(q.trim());
      const [o, r, w] = await Promise.allSettled([get(`/api/v1/orders?q=${enc}&limit=5`), get(`/api/v1/rolls?q=${enc}&limit=5`), get(`/api/v1/work-orders?q=${enc}&limit=5`)]);
      const out: { label: string; path: string }[] = [];
      if (o.status === 'fulfilled') for (const x of o.value.items) out.push({ label: `${x.orderNo} · ${x.customerName}`, path: `orders/${x.id}` });
      if (w.status === 'fulfilled') for (const x of w.value.items) out.push({ label: `${x.woNo} · ${x.modelCode}`, path: `work-orders/${x.id}` });
      if (r.status === 'fulfilled') for (const x of r.value.items) out.push({ label: `${x.rollNo} · ${x.lotNo} · ${x.materialCode}`, path: `rolls/${x.id}` });
      setRes(out);
    }, 250);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <div className="relative flex-1 max-w-md">
      <input aria-label="Genel arama" placeholder="Sipariş, iş emri, top no, lot…" value={q} onChange={(e) => setQ(e.target.value)}
        className="w-full min-h-10 rounded-lg border border-line bg-canvas px-3 text-sm text-ink placeholder:text-muted" />
      {res.length > 0 && (
        <ul className="absolute z-30 mt-1 w-full rounded-lg border border-line bg-surface shadow-lg py-1">
          {res.map((r) => <li key={r.path}><a href={'#/' + r.path} onClick={() => setQ('')} className="block px-3 py-2 text-sm text-ink hover:bg-subtle">{r.label}</a></li>)}
        </ul>
      )}
    </div>
  );
}

function Shell({ children, route }: { children: ReactNode; route: string[] }) {
  const me = useMe(); const can = useCan();
  const { online, live } = useContext(LiveContext);
  const [menu, setMenu] = useState(false);
  const active = (p: string) => (p === '' ? route.length === 0 : route[0] === p || (p === 'inventory' && route[0] === 'rolls'));
  const mobileNav = MOBILE_NAV.filter((n) => can(n.perm));
  return (
    <div className="min-h-dvh bg-canvas text-ink lg:pl-64">
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-64 flex-col border-r border-line bg-surface">
        <div className="flex items-center gap-3 px-5 h-16 border-b border-line"><Logo /><div><div className="font-bold">{t('app.name')}</div><div className="text-xs text-muted">{t('app.tagline')}</div></div></div>
        <nav className="flex-1 overflow-y-auto p-3" aria-label="Ana menü"><SectionNav route={route} /></nav>
        <div className="p-4 border-t border-line text-xs text-muted space-y-1">
          <div className="font-semibold text-ink">{me.user.displayName}</div>
          <div>{me.organization.name}</div>
          <div>{me.roles.map((r) => r.name).join(', ')}</div>
        </div>
      </aside>

      <header className="sticky top-0 z-20 flex items-center gap-3 h-14 lg:h-16 px-4 border-b border-line bg-surface/95 backdrop-blur">
        <div className="lg:hidden"><Logo /></div>
        <GlobalSearch />
        <span data-testid="conn" className={clsx('hidden sm:inline-flex items-center gap-1.5 text-xs font-medium rounded-full px-2.5 py-1 ring-1 ring-inset',
          !online ? 'bg-red-50 text-red-800 ring-red-300 dark:bg-red-950 dark:text-red-100' : live ? 'bg-emerald-50 text-emerald-800 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-100' : 'bg-subtle text-muted ring-line')}>
          <span className={clsx('size-2 rounded-full', !online ? 'bg-red-600' : live ? 'bg-emerald-600' : 'bg-slate-400')} />{!online ? t('conn.offline') : live ? t('conn.live') : t('conn.online')}
        </span>
        {me.organization.isDemo && <span className="hidden md:inline text-xs font-bold rounded px-2 py-1 bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-50">DEMO</span>}
        <ThemeToggle />
        <button className="text-xs text-muted min-h-10 px-2" onClick={() => setLocale(locale === 'tr' ? 'en' : 'tr')} aria-label="Dil">{locale === 'tr' ? 'EN' : 'TR'}</button>
        <span className="hidden lg:block"><Button variant="ghost" onClick={() => void logout()}>{t('common.logout')}</Button></span>
      </header>
      {!online && <div role="status" className="sm:hidden bg-red-700 text-white text-xs text-center py-1">{t('conn.offline')}</div>}

      <main className="p-4 lg:p-8 pb-28 lg:pb-8 max-w-7xl">{children}</main>

      <nav className="lg:hidden fixed bottom-0 inset-x-0 z-30 grid grid-cols-5 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)]" aria-label="Alt menü">
        {mobileNav.map((n) => (
          <a key={n.path} href={'#/' + n.path} aria-current={active(n.path) ? 'page' : undefined}
            className={clsx('flex flex-col items-center justify-center gap-0.5 min-h-16 text-[11px] font-medium', active(n.path) ? 'text-brand-700 dark:text-brand-300' : 'text-muted')}>
            <span className="text-lg leading-none" aria-hidden>{n.icon}</span>{t(n.label)}
          </a>
        ))}
        <button onClick={() => setMenu(true)} className="flex flex-col items-center justify-center gap-0.5 min-h-16 text-[11px] font-medium text-muted"><span className="text-lg leading-none" aria-hidden>⋯</span>{t('nav.more')}</button>
      </nav>
      {menu && (
        <div className="lg:hidden fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label={t('nav.more')}>
          <div className="absolute inset-0 bg-black/40" onClick={() => setMenu(false)} />
          <div className="absolute bottom-0 inset-x-0 max-h-[85dvh] overflow-y-auto rounded-t-2xl bg-surface p-4 pb-8 flex flex-col gap-1">
            <div className="text-sm font-semibold text-ink mb-2">{me.user.displayName} · {me.organization.code}</div>
            <nav aria-label="Bölümler"><SectionNav route={route} onNavigate={() => setMenu(false)} /></nav>
            <Button variant="secondary" className="mt-2" onClick={() => void logout()}>{t('common.logout')}</Button>
          </div>
        </div>
      )}
    </div>
  );
}

function Routes({ route }: { route: string[] }) {
  const [a, b] = route;
  switch (a) {
    case undefined: return <Home />;
    case 'orders': return b ? <OrderDetail id={b} /> : <OrdersPage />;
    case 'models': return b ? <ModelDetail id={b} /> : <ModelsPage />;
    case 'inventory': return <InventoryPage />;
    case 'rolls': return <RollDetail id={b} />;
    case 'scan': return <ScanPage />;
    case 'work-orders': return b ? <WorkOrderDetail id={b} /> : <WorkOrdersPage />;
    case 'ledger': return <LedgerPage />;
    case 'audit': return <AuditPage />;
    case 'plan': return <RoadmapPage sectionKey={b} />;
    default: return <ErrorBox error={new Error('Sayfa bulunamadı')} />;
  }
}

function Authed() {
  const route = useRoute();
  const [me, setMe] = useState<Me | null>(null); const [err, setErr] = useState<unknown>(null);
  const [tick, setTick] = useState(0); const [live, setLive] = useState(false);
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => { get<Me>('/api/v1/auth/me').then(setMe, (e) => { if (!(e instanceof ApiError && e.status === 401)) setErr(e); }); }, []);
  useEffect(() => {
    const on = () => setOnline(true); const off = () => setOnline(false);
    window.addEventListener('online', on); window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);
  useEffect(() => {
    if (!me) return;
    let pending: ReturnType<typeof setTimeout> | undefined;
    // coalesce bursts of events into one refresh of the visible screen
    return connectEvents(() => { clearTimeout(pending); pending = setTimeout(() => setTick((x) => x + 1), 300); }, (s) => setLive(s === 'live'));
  }, [me]);
  if (err) return <div className="p-6"><ErrorBox error={err} onRetry={() => location.reload()} /></div>;
  if (!me) return <Loading />;
  return (
    <MeContext.Provider value={me}>
      <LiveContext.Provider value={{ tick, online, live }}>
        <Shell route={route}><Routes route={route} /></Shell>
      </LiveContext.Provider>
    </MeContext.Provider>
  );
}

export function App() {
  const [logged, setLogged] = useState(session.isLoggedIn());
  useEffect(() => session.onChange(() => setLogged(session.isLoggedIn())), []);
  useEffect(() => { document.documentElement.lang = locale; }, []);
  return <ToastHost>{logged ? <Authed /> : <LoginScreen />}</ToastHost>;
}
