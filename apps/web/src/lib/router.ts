/**
 * A minimal client-side router: four routes do not need a routing library. The server answers
 * every non-/api path with index.html, so deep links work.
 */
import { useSyncExternalStore } from 'react'

export type Route =
  | { name: 'home' }
  | { name: 'library' }
  | { name: 'job'; id: string }
  | { name: 'song'; id: string }
  | { name: 'not-found' }

const CHANGE = 'barrefree:navigate'

export function parseRoute(pathname: string): Route {
  const path = pathname.replace(/\/+$/, '') || '/'
  if (path === '/') return { name: 'home' }
  if (path === '/library') return { name: 'library' }
  const match = /^\/(jobs|songs)\/([A-Za-z0-9_-]{1,64})$/.exec(path)
  if (match?.[2])
    return match[1] === 'jobs' ? { name: 'job', id: match[2] } : { name: 'song', id: match[2] }
  return { name: 'not-found' }
}

export function navigate(path: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, '', path)
  else window.history.pushState(null, '', path)
  window.dispatchEvent(new Event(CHANGE))
  window.scrollTo?.(0, 0)
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(CHANGE, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(CHANGE, onChange)
  }
}

export function usePathname(): string {
  return useSyncExternalStore(subscribe, () => window.location.pathname)
}

export function useRoute(): Route {
  return parseRoute(usePathname())
}
