import { useGetMe } from "@workspace/api-client-react";

/**
 * ⭐ IS THE SIGNED-IN PERSON THE HOUSEHOLD OWNER? Three answers, never two.
 *
 *   true       `/me` says owner
 *   false      `/me` says member: only then may a screen say "only the owner…"
 *   "unknown"  `/me` has not answered yet: draw a same-height placeholder,
 *              neither the owner's controls nor the denial
 *
 * If `/me` itself fails, the answer is `true`: the controls show and the
 * server (the real gate) refuses a member's save. A denial printed because a
 * request was slow was the old bug ("Only the household owner sets the weekly
 * plan" flashing for the owner).
 */
export type Owner = true | false | "unknown";

const MIN = 60_000;

export function ownerOf(me: { data?: unknown; isLoading?: boolean; isError?: boolean }): Owner {
  const data = me.data as { isOwner?: boolean } | undefined;
  if (data) return data.isOwner === true;
  if (me.isError) return true;
  return "unknown";
}

export function useOwner(opts?: { enabled?: boolean }): Owner {
  const me = useGetMe({ query: { staleTime: 30 * MIN, gcTime: 60 * MIN, enabled: opts?.enabled ?? true } as never });
  return ownerOf(me);
}
