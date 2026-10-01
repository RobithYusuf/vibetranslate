import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

// Shared building blocks for every Settings tab, so a card looks the same wherever it is:
// one surface, one icon-box size, one title/description scale. Plain markup, no state: they
// cost nothing to render and keep each tab's JSX about WHAT it shows, not how it is styled.

export type Tint = 'blue' | 'cyan' | 'green' | 'amber' | 'purple' | 'rose' | 'indigo' | 'red' | 'neutral';

// Literal class names (Tailwind only generates classes it can see in source).
const TINTS: Record<Tint, { box: string; icon: string }> = {
  blue: { box: 'bg-blue-500/15', icon: 'text-blue-400' },
  cyan: { box: 'bg-cyan-500/15', icon: 'text-cyan-400' },
  green: { box: 'bg-green-500/15', icon: 'text-green-400' },
  amber: { box: 'bg-amber-500/15', icon: 'text-amber-400' },
  purple: { box: 'bg-purple-500/15', icon: 'text-purple-400' },
  rose: { box: 'bg-rose-500/15', icon: 'text-rose-400' },
  indigo: { box: 'bg-indigo-500/15', icon: 'text-indigo-400' },
  red: { box: 'bg-red-500/15', icon: 'text-red-400' },
  neutral: { box: 'bg-white/5', icon: 'text-white/45' },
};

/** The rounded icon square used in every card header and list row. */
export function IconBox({ icon: Icon, tint = 'neutral', className = '' }: { icon: LucideIcon; tint?: Tint; className?: string }) {
  const c = TINTS[tint];
  return (
    <span className={`w-8 h-8 rounded-md grid place-items-center shrink-0 ${c.box} ${className}`}>
      <Icon size={16} className={c.icon} />
    </span>
  );
}

/** A settings card surface. `attention` adds the amber ring used for things that need action. */
export function Card({ children, attention = false, className = '' }: { children: ReactNode; attention?: boolean; className?: string }) {
  return (
    <section className={`bg-[#252526] rounded-lg p-4 space-y-3 ${attention ? 'ring-1 ring-amber-500/40' : ''} ${className}`}>
      {children}
    </section>
  );
}

/** Icon, title and one-line description, with an optional control (toggle, badge, button) on the right. */
export function CardHeader({ icon, tint, title, desc, aside }: {
  icon: LucideIcon;
  tint?: Tint;
  title: ReactNode;
  desc?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3">
      <IconBox icon={icon} tint={tint} />
      <div className="flex-1 min-w-0">
        <div className="text-[14px] font-medium text-white/90 leading-tight">{title}</div>
        {desc && <div className="text-[12px] text-white/45 mt-0.5">{desc}</div>}
      </div>
      {aside && <div className="shrink-0 flex items-center gap-2">{aside}</div>}
    </div>
  );
}

/** The common case: a card that is just a header, optionally followed by its controls. */
export function SettingCard({ children, attention, ...header }: Parameters<typeof CardHeader>[0] & { children?: ReactNode; attention?: boolean }) {
  return (
    <Card attention={attention}>
      <CardHeader {...header} />
      {children}
    </Card>
  );
}

/** Segmented choice buttons (text size, popup position). */
export function Segmented<T extends string>({ value, onChange, options }: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
}) {
  return (
    <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          aria-pressed={value === o.value}
          className={`h-11 rounded-md text-[13px] font-medium transition-colors ${
            value === o.value ? 'bg-indigo-600 text-white' : 'bg-[#1e1e1e] text-white/60 hover:text-white hover:bg-[#3c3c3c]'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Secondary and primary small buttons, so actions match across tabs. */
export const btnSecondary = 'px-3 py-1.5 text-[12px] bg-white/5 hover:bg-white/10 text-white/70 rounded border border-white/10 transition-colors disabled:opacity-50';
export const btnPrimary = 'px-3 py-1.5 text-[12px] font-medium bg-[#0e639c] hover:bg-[#1177bb] text-white rounded transition-colors disabled:opacity-50';
