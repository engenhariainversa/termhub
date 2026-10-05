import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

/**
 * In-app navigation for code that renders outside JSX's reach or must not need a router (a link inside
 * an answer's HTML, `ChatTurn`): `NavigatorBridge`, mounted once inside the router, hands its `navigate`
 * here. Without it (a component rendered on its own, in a test), a plain page load.
 */
let current: ((to: string) => void) | null = null;

export function NavigatorBridge(): null {
  const navigate = useNavigate();
  useEffect(() => {
    const fn = (to: string) => navigate(to);
    current = fn;
    return () => {
      if (current === fn) current = null;
    };
  }, [navigate]);
  return null;
}

export function appNavigate(to: string): void {
  if (current) current(to);
  else window.location.assign(to);
}
