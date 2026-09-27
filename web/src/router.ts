import { useEffect, useState } from 'react';

export type Page =
  | 'dashboard'
  | 'terminal'
  | 'files'
  | 'packages'
  | 'more'
  | 'processes'
  | 'services'
  | 'devtools'
  | 'device'
  | 'shortcuts'
  | 'jobs'
  | 'distros'
  | 'setup';

export interface Route {
  page: Page;
  params: URLSearchParams;
}

function parse(): Route {
  const [p, qs] = location.hash.replace(/^#\/?/, '').split('?');
  return { page: ((p || 'dashboard') as Page), params: new URLSearchParams(qs ?? '') };
}

export function navigate(page: Page, params?: Record<string, string>, replace = false) {
  const qs = params ? new URLSearchParams(params).toString() : '';
  const hash = `#/${page}${qs ? `?${qs}` : ''}`;
  if (replace) history.replaceState(null, '', hash);
  else history.pushState(null, '', hash);
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    window.addEventListener('popstate', on);
    return () => {
      window.removeEventListener('hashchange', on);
      window.removeEventListener('popstate', on);
    };
  }, []);
  return route;
}
