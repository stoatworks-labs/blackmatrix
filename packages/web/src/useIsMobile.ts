import { useEffect, useState } from 'react';

/**
 * Phone-shaped, rather than "is this a phone".
 *
 * The crosspoint grid does not shrink — a 4 M/E is 56 sources by 104
 * destinations — so below this width it is replaced by an X-Y panel rather than
 * squeezed. A tablet in landscape has room for the real grid and keeps it.
 */
const PHONE = '(max-width: 800px)';

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(PHONE).matches,
  );

  useEffect(() => {
    const query = window.matchMedia(PHONE);
    const onChange = (event: MediaQueryListEvent): void => setIsMobile(event.matches);
    query.addEventListener('change', onChange);
    setIsMobile(query.matches);
    return () => query.removeEventListener('change', onChange);
  }, []);

  return isMobile;
}
