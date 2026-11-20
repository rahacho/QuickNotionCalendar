import { forwardRef } from 'react';
import type { LucideIcon, LucideProps } from 'lucide-react';
import { cx } from '@/lib/cx';
import styles from './Icon.module.css';

export interface IconProps extends Omit<LucideProps, 'ref' | 'size'> {
  icon: LucideIcon;
  /** Pixel size (default 16, Notion's standard). */
  size?: number;
}

/** Lucide icon with Notion defaults: 16px, strokeWidth 1.75, color var(--icon), decorative. */
export const Icon = forwardRef<SVGSVGElement, IconProps>(function Icon(
  { icon: Glyph, size = 16, strokeWidth = 1.75, className, ...rest },
  ref,
) {
  return (
    <Glyph
      ref={ref}
      size={size}
      strokeWidth={strokeWidth}
      aria-hidden={rest['aria-label'] ? undefined : true}
      focusable="false"
      className={cx(styles.icon, className)}
      {...rest}
    />
  );
});
