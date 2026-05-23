import { type ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

interface PageHeaderProps {
  eyebrow?: string;
  title: string;
  sub?: string;
  right?: ReactNode;
  className?: string;
}

export function PageHeader({ eyebrow, title, sub, right, className }: PageHeaderProps) {
  return (
    <div className={cn('flex items-start justify-between gap-4 mb-6', className)}>
      <div className="flex-1 min-w-0">
        {eyebrow && (
          <div className="text-xs font-bold uppercase tracking-[0.15em] text-blue-600 mb-1.5">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 tracking-tight">
          {title}
        </h1>
        {sub && (
          <p className="mt-1.5 text-[15px] text-gray-500 leading-relaxed">
            {sub}
          </p>
        )}
      </div>
      {right && <div className="flex-shrink-0">{right}</div>}
    </div>
  );
}
