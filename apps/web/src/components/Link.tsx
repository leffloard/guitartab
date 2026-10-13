import type { AnchorHTMLAttributes, MouseEvent } from 'react'

import { navigate } from '../lib/router'

/** An <a> that navigates without reloading; modified clicks (new tab) work as usual. */
export function Link({
  href,
  onClick,
  ...rest
}: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) {
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e)
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey)
      return
    e.preventDefault()
    navigate(href)
  }
  return <a href={href} onClick={handle} {...rest} />
}
