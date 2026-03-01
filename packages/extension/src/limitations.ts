import type { Locator } from '@bak/protocol';

export interface UnsupportedLocator {
  reason: 'shadow-dom' | 'iframe';
  hint: string;
}

const SHADOW_SELECTOR_PATTERN = /(>>>|::part|::slotted|\bshadowroot\b)/i;
const FRAME_SELECTOR_PATTERN = /(^|[\s>+~,(])(?:iframe|frame)(?=[$.#:[\s>+~,(]|$)/i;

export function unsupportedLocator(locator?: Locator): UnsupportedLocator | null {
  if (!locator?.css) {
    return null;
  }

  const css = locator.css;
  if (SHADOW_SELECTOR_PATTERN.test(css)) {
    return {
      reason: 'shadow-dom',
      hint: 'shadow-dom selectors are not supported in v1'
    };
  }

  if (FRAME_SELECTOR_PATTERN.test(css)) {
    return {
      reason: 'iframe',
      hint: 'iframe selectors are not supported in v1'
    };
  }

  return null;
}

export function unsupportedLocatorHint(locator?: Locator): string | null {
  return unsupportedLocator(locator)?.hint ?? null;
}
