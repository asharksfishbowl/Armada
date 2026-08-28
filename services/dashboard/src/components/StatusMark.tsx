/**
 * The six status marks — design-dashboard.md Requirements 18-22.
 *
 * SVG GEOMETRY, NEVER FONT GLYPHS (Requirement 20). Unicode `●○◐▲✕◌` would depend on
 * whichever font happened to resolve, would shift baseline between them, and several
 * render as emoji on some platforms. Geometry stays legible at 12px and, more importantly,
 * survives the desaturation of Requirement 141 — which is the whole reason shape rather
 * than hue carries the primary distinction.
 *
 * FILL HAS MEANING ONLY WITHIN THE DISC FAMILY (Requirement 19): filled = a verdict
 * exists, hollow = stopped before a verdict, half = a verdict is pending. `triangle`,
 * `cross-square`, and `ring-dotted` are separate shape classes and carry no fill meaning,
 * which is why none of them has a hollow variant.
 *
 * The mark is `aria-hidden` in every case. It is never the sole carrier of meaning —
 * Requirement 32 makes a text label mandatory on every chip — so announcing the shape as
 * well would read the status twice.
 */

import type { StatusMarkKind } from '../lib/status';

export interface StatusMarkProps {
  kind: StatusMarkKind;
  /** A `--status-*` token name. Rendered at its declared value only (Requirement 32c). */
  hue: string;
  size?: number;
  /** Requirement 21 — only a `running` half-disc ever sets this. Requirement 22 makes it
   *  the only rotating element in the application. */
  rotating?: boolean;
}

export function StatusMark({ kind, hue, size = 12, rotating = false }: StatusMarkProps) {
  const colour = `var(${hue})`;
  // A 16-unit viewBox with a 6-unit radius keeps every mark on one optical size: the
  // triangle and the square are inscribed rather than bounding-box matched, so a `▲` does
  // not read as larger than a `●` in the same column.
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 16 16',
    'aria-hidden': true as const,
    focusable: 'false' as const,
    style: { display: 'block', flex: '0 0 auto' },
  };

  switch (kind) {
    case 'disc-filled':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="5" fill={colour} />
        </svg>
      );

    case 'disc-hollow':
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="4.5" fill="none" stroke={colour} strokeWidth="1.6" />
        </svg>
      );

    case 'disc-half':
      // Half the disc filled, the whole outlined. The outline is what keeps it readable as
      // "a disc, partly resolved" rather than "a smaller shape" once it is rotating.
      return (
        <svg {...common} className={rotating ? 'mark-rotating' : undefined}>
          <circle cx="8" cy="8" r="4.5" fill="none" stroke={colour} strokeWidth="1.6" />
          <path d="M8 3.5 A4.5 4.5 0 0 1 8 12.5 Z" fill={colour} />
        </svg>
      );

    case 'disc-slashed':
      // Requirement 142: the slash is load-bearing. It is the ONLY thing separating
      // `cancelled` from `budget_exhausted` once both are desaturated to the same grey
      // hollow ring.
      return (
        <svg {...common}>
          <circle cx="8" cy="8" r="4.5" fill="none" stroke={colour} strokeWidth="1.6" />
          <line x1="4.8" y1="11.2" x2="11.2" y2="4.8" stroke={colour} strokeWidth="1.6" />
        </svg>
      );

    case 'triangle':
      return (
        <svg {...common}>
          <path d="M8 2.6 L14 12.8 L2 12.8 Z" fill={colour} />
        </svg>
      );

    case 'cross-square':
      // Requirement 29 — `missing`. A square rather than a disc because it is an integrity
      // fault rather than an outcome, and Requirement 30 makes it the only status that
      // escalates past its own row.
      return (
        <svg {...common}>
          <rect x="2.5" y="2.5" width="11" height="11" rx="1.5" fill="none" stroke={colour} strokeWidth="1.6" />
          <line x1="5.6" y1="5.6" x2="10.4" y2="10.4" stroke={colour} strokeWidth="1.6" />
          <line x1="10.4" y1="5.6" x2="5.6" y2="10.4" stroke={colour} strokeWidth="1.6" />
        </svg>
      );

    case 'ring-dotted':
      // Requirement 114 — a CONNECTION mark, not an outcome. Dotted so it cannot be
      // misread as a hollow disc, which would put it in the fill family and assert that
      // something was stopped before a verdict.
      return (
        <svg {...common}>
          <circle
            cx="8"
            cy="8"
            r="4.5"
            fill="none"
            stroke={colour}
            strokeWidth="1.6"
            strokeDasharray="1.8 1.8"
          />
        </svg>
      );
  }
}
