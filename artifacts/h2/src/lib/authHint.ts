/**
 * ⭐ INSTANT OPEN — the auth hint, ported from the classic app.
 *
 * `h2:auth-hint` records that this browser has resolved to a signed-in session
 * before. When it is set the shell paints at once and Clerk catches up. It is a
 * HINT, never an authorisation: it gates pixels, not data. The shell it
 * unlocks holds zero numbers, and every byte of real data still needs the
 * server to accept the session cookie.
 *
 * The key is shared with the classic app on purpose: both apps sit on one
 * origin behind one Clerk session, so they should agree on it.
 */
export const AUTH_HINT_KEY = "h2:auth-hint";

export function readAuthHint(): boolean {
  try {
    return window.localStorage.getItem(AUTH_HINT_KEY) === "1";
  } catch {
    // Private mode / storage disabled: the slow-but-correct path.
    return false;
  }
}

export function writeAuthHint(on: boolean): void {
  try {
    if (on) window.localStorage.setItem(AUTH_HINT_KEY, "1");
    else window.localStorage.removeItem(AUTH_HINT_KEY);
  } catch {
    /* the hint is an optimisation, never a requirement */
  }
}
