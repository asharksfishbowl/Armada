/**
 * Colour maths for the two build-time assertions design-dashboard.md makes.
 *
 * Requirement 139 states the test IS the requirement: "Every status hue meets a contrast
 * ratio of at least 4.5:1 against both --surface-2 and --surface-3, asserted by an
 * automated token test at build time." The measured table in the spec is explicitly
 * informative. So the numbers are not restated anywhere in this repo — they are
 * recomputed from styles/tokens.css on every `npm test`.
 *
 * WCAG 2.1 relative luminance and contrast ratio, implemented directly rather than pulled
 * from a package: it is nine lines, it is frozen by a published standard, and a colour
 * library is a dependency and a THIRD_PARTY_NOTICES entry for arithmetic.
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses `#RRGGBB`. Throws rather than returning a default — a token that does not parse
 *  is a broken token, and a silent black would make the contrast test pass loudly. */
export function parseHex(hex: string): Rgb {
  const match = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!match?.[1]) throw new Error(`not a #RRGGBB colour: ${JSON.stringify(hex)}`);
  const n = parseInt(match[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/** WCAG 2.1 relative luminance, 0 (black) to 1 (white). */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * channel(rgb.r) + 0.7152 * channel(rgb.g) + 0.0722 * channel(rgb.b);
}

/** WCAG 2.1 contrast ratio, 1:1 to 21:1. Order-independent. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Greyscale value of a colour, 0 to 1 — what survives the desaturation of Requirement 141.
 *
 * Relative luminance is the right model for "desaturated to greyscale" because it is what
 * a luminance-preserving greyscale conversion produces, and because it is the same
 * quantity the contrast floor is measured in. Two hues with the same relative luminance
 * are the same grey, which is exactly the collision Requirement 141 predicts and
 * Requirement 142b requires shape and label to survive.
 */
export function greyscale(hex: string): number {
  return relativeLuminance(parseHex(hex));
}

/**
 * Extracts `--name: #RRGGBB;` declarations from a CSS source string.
 *
 * Reads the stylesheet as TEXT rather than importing a TypeScript token module, because
 * the browser renders the stylesheet. A .ts mirror of these values could pass every test
 * while the .css the application actually loads had drifted.
 *
 * Only six-digit hex declarations are collected. `--accent-wash` and the `--tint-*` tokens
 * are rgba() and are deliberately skipped: Requirement 32d places them in the class that
 * carries no contrast floor because nothing in it is a sole carrier of meaning (32e).
 */
export function parseHexTokens(css: string): Map<string, string> {
  const tokens = new Map<string, string>();
  const pattern = /(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  for (const match of css.matchAll(pattern)) {
    const [, name, value] = match;
    if (name && value) tokens.set(name, value);
  }
  return tokens;
}
