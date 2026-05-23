import { type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

type BannerTone = 'info' | 'success' | 'warn' | 'danger' | 'neutral' | 'promo';
type BannerSize = 'sm' | 'md' | 'lg';
type BannerShape = 'card' | 'strip' | 'inline';

interface BannerAction {
  label: string;
  onClick?: () => void;
  variant?: 'primary' | 'ghost';
}

interface BannerProps {
  tone?: BannerTone;
  size?: BannerSize;
  shape?: BannerShape;
  icon?: ReactNode;
  eyebrow?: string;
  title?: ReactNode;
  body?: ReactNode;
  action?: BannerAction;
  secondary?: BannerAction;
  onDismiss?: () => void;
  children?: ReactNode;
  className?: string;
}

const TONES: Record<BannerTone, {
  bg: string;
  ring: string;
  ink: string;
  iconBg: string;
  iconInk: string;
}> = {
  info:    { bg: 'bg-blue-50',   ring: 'ring-blue-200',   ink: 'text-blue-900',   iconBg: 'bg-blue-100',   iconInk: 'text-blue-700' },
  success: { bg: 'bg-green-50',  ring: 'ring-green-200',  ink: 'text-green-900',  iconBg: 'bg-green-100',  iconInk: 'text-green-700' },
  warn:    { bg: 'bg-amber-50',  ring: 'ring-amber-200',  ink: 'text-amber-900',  iconBg: 'bg-amber-100',  iconInk: 'text-amber-700' },
  danger:  { bg: 'bg-red-50',    ring: 'ring-red-200',    ink: 'text-red-900',    iconBg: 'bg-red-100',    iconInk: 'text-red-700' },
  neutral: { bg: 'bg-gray-50',   ring: 'ring-gray-200',   ink: 'text-gray-900',   iconBg: 'bg-gray-100',   iconInk: 'text-gray-700' },
  promo:   { bg: 'bg-purple-50', ring: 'ring-purple-200', ink: 'text-purple-900', iconBg: 'bg-purple-100', iconInk: 'text-purple-700' },
};

const SIZES: Record<BannerSize, {
  padding: string;
  gap: string;
  iconBox: string;
  titleSize: string;
  bodySize: string;
  actionPad: string;
}> = {
  sm: { padding: 'p-3', gap: 'gap-2.5', iconBox: 'w-8 h-8',   titleSize: 'text-[13px]', bodySize: 'text-[12px]', actionPad: 'px-2.5 py-1 text-[12px]' },
  md: { padding: 'p-4', gap: 'gap-3',   iconBox: 'w-9 h-9',   titleSize: 'text-[14px]', bodySize: 'text-[13px]', actionPad: 'px-3 py-1.5 text-[13px]' },
  lg: { padding: 'p-5', gap: 'gap-4',   iconBox: 'w-11 h-11', titleSize: 'text-[16px]', bodySize: 'text-[14px]', actionPad: 'px-3.5 py-2 text-[14px]' },
};

const SHAPES: Record<BannerShape, string> = {
  card:   'rounded-2xl ring-1 shadow-sm',
  strip:  'rounded-xl ring-1',
  inline: 'rounded-lg ring-1',
};

export function Banner({
  tone = 'info',
  size = 'md',
  shape = 'card',
  icon,
  eyebrow,
  title,
  body,
  action,
  secondary,
  onDismiss,
  children,
  className,
}: BannerProps) {
  const t = TONES[tone];
  const s = SIZES[size];
  const sh = SHAPES[shape];

  return (
    <div
      role="status"
      className={cn(
        'relative flex items-start',
        s.gap, s.padding, sh,
        t.bg, t.ring, t.ink,
        className,
      )}
    >
      {/* Decorative soft glow behind icon (design's .bn-glow; card shape only) */}
      {icon && shape === 'card' && (
        <span
          aria-hidden="true"
          className={cn(
            'pointer-events-none absolute -top-2 -left-2 rounded-full blur-2xl opacity-30',
            s.iconBox,
            t.iconBg,
          )}
        />
      )}

      {icon && (
        <div
          className={cn(
            'relative flex-shrink-0 inline-flex items-center justify-center rounded-xl',
            s.iconBox,
            t.iconBg,
            t.iconInk,
          )}
          aria-hidden="true"
        >
          {icon}
        </div>
      )}

      <div className="flex-1 min-w-0">
        {eyebrow && (
          <div className={cn(
            'text-[10px] font-bold uppercase tracking-[0.15em] mb-0.5',
            t.iconInk,
          )}>
            {eyebrow}
          </div>
        )}
        {title && (
          <div className={cn('font-semibold leading-snug', s.titleSize)}>
            {title}
          </div>
        )}
        {body && (
          <div className={cn('mt-0.5 leading-relaxed opacity-80', s.bodySize)}>
            {body}
          </div>
        )}
        {children}
      </div>

      {(action || secondary) && (
        <div className="relative flex-shrink-0 flex items-center gap-1.5">
          {secondary && (
            <button
              onClick={secondary.onClick}
              className={cn(
                'font-semibold rounded-lg transition-colors',
                'text-gray-700 hover:bg-black/5',
                s.actionPad,
              )}
            >
              {secondary.label}
            </button>
          )}
          {action && (
            <button
              onClick={action.onClick}
              className={cn(
                'font-semibold rounded-lg transition-colors',
                (action.variant || 'primary') === 'primary'
                  ? 'bg-blue-600 text-white hover:bg-blue-700'
                  : 'text-gray-700 hover:bg-black/5',
                s.actionPad,
              )}
            >
              {action.label}
            </button>
          )}
        </div>
      )}

      {onDismiss && (
        <button
          onClick={onDismiss}
          aria-label="Dismiss"
          className={cn(
            'relative flex-shrink-0 inline-flex items-center justify-center w-7 h-7 rounded-lg transition-colors',
            'hover:bg-black/5',
            t.iconInk,
          )}
        >
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      )}

    </div>
  );
}
