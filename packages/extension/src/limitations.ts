import type { Locator } from '@bak/protocol';

export function unsupportedLocatorHint(locator?: Locator): string | null {
  if (!locator?.css) {
    return null;
  }

  const css = locator.css.toLowerCase();
  if (
    css.includes('>>>') ||
    css.includes('::part') ||
    css.includes('::slotted') ||
    css.includes('shadowroot')
  ) {
    return 'shadow-dom selectors are not supported in v1';
  }

  if (css.includes('iframe') || css.includes('frame')) {
    return 'iframe selectors are not supported in v1';
  }

  return null;
}
