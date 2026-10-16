import type { SVGProps } from "react";
import { BRAND_NAME } from "@/lib/brand";

interface PaperclipLockupProps extends Omit<SVGProps<SVGSVGElement>, "children"> {
  decorative?: boolean;
  title?: string;
}

/**
 * Dixie Flatline lockup — the "DF" terminal monogram plus wordmark. Kept under
 * the upstream component name so every existing call site picks it up without
 * a source change. The monogram keeps its fixed brand colors (ink #0b0f14,
 * terminal green #39ff88); the wordmark fills `currentColor` so it follows the
 * theme.
 *
 * Size it with a height class (`h-5 w-auto`); width follows the aspect.
 */
export function PaperclipLockup({
  decorative = false,
  title = BRAND_NAME,
  className,
  ...rest
}: PaperclipLockupProps) {
  return (
    <svg
      {...rest}
      className={className}
      viewBox="0 0 200 32"
      role={decorative ? undefined : "img"}
      aria-hidden={decorative ? true : undefined}
      aria-label={decorative ? undefined : title}
      focusable="false"
    >
      <rect width="32" height="32" rx="6" fill="#0b0f14" />
      <g
        transform="scale(0.5) translate(-2 0)"
        fill="none"
        stroke="#39ff88"
        strokeWidth="6"
        strokeLinecap="square"
      >
        <path d="M15 19V45H22A13 13 0 0 0 22 19Z" />
        <path d="M43 45V19H53M43 31H51" />
      </g>
      <text
        x="42"
        y="23"
        fill="currentColor"
        fontFamily="inherit"
        fontWeight="600"
        textLength="156"
        lengthAdjust="spacingAndGlyphs"
        fontSize="20"
      >
        {BRAND_NAME}
      </text>
    </svg>
  );
}
