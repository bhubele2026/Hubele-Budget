/**
 * (perf phase 2) WHOSE DATA IS IN MEMORY? The open may ask for the spine (and /me) on the session cookie before
 * Clerk has said who is signed in. When Clerk then names a user, everything fetched must be that user's:
 *   - a later change of user (sign-out/sign-in, a session switch) clears the cache, as before;
 *   - the FIRST word from Clerk clears it too when what the cookie fetched names someone else (/me's userId).
 * Returns true when the query cache must be emptied.
 */
export function mustClearForClerkUser(
  previous: string | null | undefined,
  next: string | null,
  fetchedForUserId: string | null | undefined,
): boolean {
  if (previous !== undefined) return previous !== next;
  return next != null && fetchedForUserId != null && fetchedForUserId !== next;
}
