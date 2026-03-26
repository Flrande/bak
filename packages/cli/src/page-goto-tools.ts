export interface ReusableTabCandidate {
  id: number;
  url: string;
  active?: boolean;
}

export interface PageGotoReuseOptions {
  reuseDomain?: boolean;
  reuseUrlContains?: string;
}

export interface ReusableTabMatch {
  tab: ReusableTabCandidate;
  matchedBy: 'domain' | 'url-contains' | 'domain+url-contains';
}

function safeHostname(urlText: string): string | null {
  try {
    return new URL(urlText).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function hasPageGotoReuseOptions(options: PageGotoReuseOptions): boolean {
  return options.reuseDomain === true || (typeof options.reuseUrlContains === 'string' && options.reuseUrlContains.trim().length > 0);
}

export function selectReusableTab(
  targetUrl: string,
  tabs: ReusableTabCandidate[],
  options: PageGotoReuseOptions
): ReusableTabMatch | null {
  const reuseDomain = options.reuseDomain === true;
  const reuseUrlContains = typeof options.reuseUrlContains === 'string' ? options.reuseUrlContains.trim() : '';
  if (!reuseDomain && !reuseUrlContains) {
    return null;
  }

  const targetHostname = reuseDomain ? safeHostname(targetUrl) : null;
  const matches = tabs.filter((tab) => {
    if (reuseDomain) {
      const hostname = safeHostname(tab.url);
      if (!hostname || !targetHostname || hostname !== targetHostname) {
        return false;
      }
    }
    if (reuseUrlContains && !tab.url.includes(reuseUrlContains)) {
      return false;
    }
    return true;
  });
  if (matches.length === 0) {
    return null;
  }

  const tab = matches.find((candidate) => candidate.active) ?? matches[0]!;
  return {
    tab,
    matchedBy: reuseDomain && reuseUrlContains ? 'domain+url-contains' : reuseDomain ? 'domain' : 'url-contains'
  };
}
