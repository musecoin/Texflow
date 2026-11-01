import { cloneElement, createContext, isValidElement, useCallback, useContext, useEffect, useId, useRef, useState, type ReactElement, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes, type SelectHTMLAttributes } from 'react';
import { clsx } from 'clsx';
import { ApiError } from './api.ts';
import { t, fmtDateTime } from './i18n.ts';

// ---------------------------------------------------------------- live refresh + data loading
export const LiveContext = createContext<{ tick: number; online: boolean; live: boolean }>({ tick: 0, online: true, live: false });

export function useLoad<T>(fn: () => Promise<T>, deps: unknown[]) {
  const { tick } = useContext(LiveContext);
  const [state, set] = useState<{ data?: T; error?: ApiError; loading: boolean }>({ loading: true });
  const [n, setN] = useState(0);
  const fnRef = useRef(fn); fnRef.current = fn;
  useEffect(() => {
    let alive = true;
    set((s) => ({ ...s, loading: true }));
    fnRef.current().then((data) => alive && set({ data, loading: false }), (error) => alive && set((s) => ({ ...s, error, loading: false })));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick, n]);
  return { ...state, reload: useCallback(() => setN((x) => x + 1), []) };
}

// ---------------------------------------------------------------- toasts (only after server acknowledgement)
type Toast = { id: number; kind: 'ok' | 'err'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export function ToastHost({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x, { id, kind, text }]);
    setTimeout(() => setItems((x) => x.filter((i) => i.id !== id)), kind === 'err' ? 8000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="fixed z-50 bottom-20 lg:bottom-6 right-4 left-4 lg:left-auto flex flex-col gap-2 items-end pointer-events-none" aria-live="polite">
        {items.map((i) => (
          <div key={i.id} role={i.kind === 'err' ? 'alert' : 'status'}
            className={clsx('pointer-events-auto max-w-md w-full lg:w-96 rounded-lg px-4 py-3 text-sm shadow-lg border',
              i.kind === 'ok' ? 'bg-emerald-50 border-emerald-300 text-emerald-900 dark:bg-emerald-950 dark:border-emerald-700 dark:text-emerald-100'
                : 'bg-red-50 border-red-300 text-red-900 dark:bg-red-950 dark:border-red-700 dark:text-red-100')}>
            {i.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

/** Wraps a command: one idempotency key per user action; success toast only on 2xx. */
export function useCommand() {
  const toast = useToast();
  const { online } = useContext(LiveContext);
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: (idempotencyKey: string) => Promise<T>, okText?: string): Promise<T | undefined> => {
    if (!online) { toast('err', t('conn.offline')); return undefined; }
    setBusy(true);
    const key = crypto.randomUUID();
    try { const r = await fn(key); if (okText) toast('ok', okText); return r; }
    catch (e) { toast('err', errorText(e)); return undefined; }
    finally { setBusy(false); }
  }, [online, toast]);
  return { run, busy };
}

export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const det = Array.isArray(e.details) ? ' — ' + (e.details as { path: string; message: string }[]).slice(0, 3).map((d) => `${d.path}: ${d.message}`).join('; ') : '';
    return `${e.message}${det} [${e.code}]`;
  }
  return (e as Error)?.message ?? String(e);
}

// ---------------------------------------------------------------- primitives
export function Button({ variant = 'primary', loading, className, children, ...p }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; loading?: boolean }) {
  return (
    <button {...p} disabled={p.disabled || loading}
      className={clsx('inline-flex items-center justify-center gap-2 rounded-lg px-4 min-h-11 text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-500 disabled:opacity-50 disabled:cursor-not-allowed',
        variant === 'primary' && 'bg-brand-700 text-white hover:bg-brand-800 dark:bg-brand-400 dark:text-onbrand dark:hover:bg-brand-300',
        variant === 'secondary' && 'bg-surface text-ink border border-line hover:bg-subtle',
        variant === 'danger' && 'bg-red-700 text-white hover:bg-red-800',
        variant === 'ghost' && 'text-ink hover:bg-subtle', className)}>
      {loading && <span className="size-4 rounded-full border-2 border-current border-t-transparent animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Card({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('rounded-xl border border-line bg-surface shadow-sm', className)}>
      {(title || actions) && <header className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-line"><h2 className="font-semibold text-ink">{title}</h2><div className="flex flex-wrap gap-2">{actions}</div></header>}
      <div className="p-4">{children}</div>
    </section>
  );
}

const TONE: Record<string, string> = {
  DRAFT: 'slate', IN_REVIEW: 'amber', PENDING: 'amber', PLANNED: 'slate', QUARANTINE: 'amber', AWAITING_CONFIRMATION: 'slate', AWAITING_WORK_ORDER: 'amber',
  AWAITING_RELEASE: 'amber', AWAITING_MATERIAL: 'amber', CONFIRMED: 'blue', RELEASED: 'blue', IN_PRODUCTION: 'blue', IN_PROGRESS: 'blue', ACTIVE: 'blue',
  TECH_APPROVED: 'green', APPROVED: 'green', ACCEPTED: 'green', PASS: 'green', COMPLETED: 'green', SHIPPED: 'green', MATERIAL_RESERVED: 'green',
  REJECTED: 'red', FAIL: 'red', CANCELLED: 'red', OBSOLETE: 'slate', ARCHIVED: 'slate', RELEASED_RES: 'slate',
};
const TONE_CLS: Record<string, string> = {
  slate: 'bg-slate-100 text-slate-800 ring-slate-300 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-600',
  amber: 'bg-amber-50 text-amber-900 ring-amber-300 dark:bg-amber-950 dark:text-amber-100 dark:ring-amber-700',
  blue: 'bg-sky-50 text-sky-900 ring-sky-300 dark:bg-sky-950 dark:text-sky-100 dark:ring-sky-700',
  green: 'bg-emerald-50 text-emerald-900 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-100 dark:ring-emerald-700',
  red: 'bg-red-50 text-red-900 ring-red-300 dark:bg-red-950 dark:text-red-100 dark:ring-red-700',
};
export function Badge({ status, label }: { status: string; label?: string }) {
  const k = status in TONE ? status : 'DRAFT';
  const text = label ?? (t('status.' + status) !== 'status.' + status ? t('status.' + status) : t('stage.' + status) !== 'stage.' + status ? t('stage.' + status) : status);
  return <span data-status={status} className={clsx('inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset whitespace-nowrap', TONE_CLS[TONE[k]])}>{text}</span>;
}

export function Field({ label, hint, error, children, className }: { label: string; hint?: string; error?: string; children: ReactNode; className?: string }) {
  // explicit <label for> so the accessible name is exactly the label text (a wrapping label would
  // also absorb a <select>'s option texts into the name)
  const id = useId();
  const hintId = hint ? id + '-hint' : undefined;
  const control = isValidElement(children)
    ? cloneElement(children as ReactElement<{ id?: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }>, { id, 'aria-describedby': hintId, 'aria-invalid': error ? true : undefined })
    : children;
  return (
    <div className={clsx('flex flex-col gap-1 text-sm', className)}>
      <label htmlFor={id} className="font-medium text-ink">{label}</label>
      {control}
      {hint && <span id={hintId} className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs text-red-700 dark:text-red-300">{error}</span>}
    </div>
  );
}
const inputCls = 'min-h-11 rounded-lg border border-line bg-surface px-3 text-ink placeholder:text-muted focus:outline-2 focus:outline-brand-500 w-full';
export function Input(p: InputHTMLAttributes<HTMLInputElement>) { return <input {...p} className={clsx(inputCls, p.className)} />; }
export function Select({ options, placeholder, ...p }: SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string }[]; placeholder?: string }) {
  return (
    <select {...p} className={clsx(inputCls, p.className)}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
    </select>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
      <div><h1 className="text-xl lg:text-2xl font-bold tracking-tight text-ink">{title}</h1>{subtitle && <p className="text-sm text-muted mt-1">{subtitle}</p>}</div>
      <div className="flex flex-wrap gap-2">{actions}</div>
    </div>
  );
}

export function Loading() { return <div className="py-10 text-center text-muted text-sm" role="status">{t('common.loading')}</div>; }
export function Empty({ text }: { text?: string }) { return <div className="py-8 text-center text-muted text-sm">{text ?? t('common.empty')}</div>; }
export function ErrorBox({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div role="alert" className="rounded-lg border border-red-300 bg-red-50 dark:bg-red-950 dark:border-red-800 p-4 text-sm text-red-900 dark:text-red-100 flex flex-wrap items-center justify-between gap-3">
      <span>{errorText(error)}</span>{onRetry && <Button variant="secondary" onClick={onRetry}>{t('common.retry')}</Button>}
    </div>
  );
}

/** Data table on desktop, stacked cards on phones (labels come from the column headers). */
export function Table<T>({ rows, cols, onRow, rowKey, empty }: { rows: T[]; cols: { h: string; c: (r: T) => ReactNode; cls?: string; num?: boolean }[]; onRow?: (r: T) => void; rowKey: (r: T) => string; empty?: string }) {
  if (!rows.length) return <Empty text={empty} />;
  return (
    <>
      <div className="hidden md:block overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs uppercase tracking-wide text-muted border-b border-line">{cols.map((c) => <th key={c.h} className={clsx('py-2 px-3 font-semibold', c.num && 'text-right')}>{c.h}</th>)}</tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={rowKey(r)} onClick={onRow ? () => onRow(r) : undefined} className={clsx('border-b border-line last:border-0', onRow && 'cursor-pointer hover:bg-subtle')}>
                {cols.map((c) => <td key={c.h} className={clsx('py-2.5 px-3 align-middle', c.num && 'text-right tabular-nums', c.cls)}>{c.c(r)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="md:hidden flex flex-col gap-2">
        {rows.map((r) => (
          <li key={rowKey(r)}>
            <button type="button" disabled={!onRow} onClick={onRow ? () => onRow(r) : undefined} className="w-full text-left rounded-lg border border-line bg-surface p-3 active:bg-subtle disabled:cursor-default">
              <dl className="grid grid-cols-2 gap-x-3 gap-y-1 text-sm">
                {cols.map((c) => <div key={c.h} className="contents"><dt className="text-muted text-xs self-center">{c.h}</dt><dd className={clsx('text-ink', c.num && 'tabular-nums')}>{c.c(r)}</dd></div>)}
              </dl>
            </button>
          </li>
        ))}
      </ul>
    </>
  );
}

export function Stat({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: 'amber' | 'green' | 'red' }) {
  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="text-xs font-medium uppercase tracking-wide text-muted">{label}</div>
      <div className={clsx('mt-1 text-2xl font-bold tabular-nums', tone === 'amber' && 'text-amber-700 dark:text-amber-300', tone === 'green' && 'text-emerald-700 dark:text-emerald-300', tone === 'red' && 'text-red-700 dark:text-red-300', !tone && 'text-ink')}>{value}</div>
      {hint && <div className="mt-1 text-xs text-muted">{hint}</div>}
    </div>
  );
}

export function Sheet({ open, title, onClose, children }: { open: boolean; title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    if (!open) return;
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative w-full sm:max-w-2xl h-full bg-canvas shadow-xl overflow-y-auto">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 px-4 py-3 border-b border-line bg-surface">
          <h2 className="font-semibold text-ink">{title}</h2>
          <Button variant="ghost" onClick={onClose} aria-label={t('common.close')}>✕</Button>
        </div>
        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}

export function Timeline({ items }: { items: { at: string; title: ReactNode; who?: string; detail?: ReactNode }[] }) {
  if (!items.length) return <Empty />;
  return (
    <ol className="relative border-l-2 border-line ml-2">
      {items.map((i, n) => (
        <li key={n} className="ml-4 pb-4 last:pb-0">
          <span className="absolute -left-[7px] mt-1.5 size-3 rounded-full bg-brand-600 ring-4 ring-canvas" aria-hidden />
          <div className="text-sm font-medium text-ink">{i.title}</div>
          <div className="text-xs text-muted">{fmtDateTime(i.at)}{i.who ? ` · ${i.who}` : ''}</div>
          {i.detail && <div className="mt-1 text-xs text-muted">{i.detail}</div>}
        </li>
      ))}
    </ol>
  );
}

export function Stepper({ steps, current }: { steps: { key: string; label: string }[]; current: string }) {
  const idx = steps.findIndex((s) => s.key === current);
  return (
    <ol className="flex flex-wrap gap-2" aria-label="İlerleme">
      {steps.map((s, i) => (
        <li key={s.key} aria-current={i === idx ? 'step' : undefined}
          className={clsx('flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ring-1 ring-inset',
            i < idx && 'bg-emerald-50 text-emerald-900 ring-emerald-300 dark:bg-emerald-950 dark:text-emerald-100 dark:ring-emerald-700',
            i === idx && 'bg-brand-700 text-white ring-brand-700 dark:bg-brand-400 dark:text-onbrand dark:ring-brand-400',
            i > idx && 'bg-surface text-muted ring-line')}>
          <span className="tabular-nums">{i + 1}</span>{s.label}
        </li>
      ))}
    </ol>
  );
}

export function Kv({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-2 md:grid-cols-4 gap-x-4 gap-y-3 text-sm">
      {items.map(([k, v]) => <div key={k}><dt className="text-xs text-muted">{k}</dt><dd className="text-ink font-medium break-words">{v ?? '—'}</dd></div>)}
    </dl>
  );
}
