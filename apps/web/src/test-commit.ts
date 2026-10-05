/**
 * Runs `action` at the first DOM mutation after which `ready()` holds: right after React commits that
 * screen and before it runs the commit's passive effects (`useEffect`). That gap is where a fast person
 * acts, and where a `waitFor` lands now and then on a busy CI runner. A test that acts there proves the
 * component does not let a late effect overwrite what the person just did (TER-911).
 *
 * Only meaningful for a screen that appears in a commit outside `act` (after a mocked request
 * resolves): if `ready()` already holds, React flushed everything inside `act` and `action` runs now.
 */
export async function actRightAfterCommit(ready: () => boolean, action: () => void): Promise<void> {
  const holds = () => {
    try {
      return ready();
    } catch {
      return false;
    }
  };
  if (holds()) {
    action();
    return;
  }
  const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
  const previous = env.IS_REACT_ACT_ENVIRONMENT;
  env.IS_REACT_ACT_ENVIRONMENT = false; // updates outside act go through React's scheduler, as in a browser
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error('actRightAfterCommit: the screen never got ready'));
      }, 4_000);
      const observer = new MutationObserver(() => {
        if (!holds()) return;
        observer.disconnect();
        clearTimeout(timer);
        try {
          action();
          resolve();
        } catch (e) {
          reject(e);
        }
      });
      observer.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    });
  } finally {
    env.IS_REACT_ACT_ENVIRONMENT = previous;
  }
}
