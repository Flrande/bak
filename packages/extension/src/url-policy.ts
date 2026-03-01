export function isSupportedAutomationUrl(url?: string): boolean {
  if (typeof url !== 'string' || !url) {
    return false;
  }

  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}
