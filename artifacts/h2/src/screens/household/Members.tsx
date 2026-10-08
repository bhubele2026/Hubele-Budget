import { useRef, useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import {
  getGetMeQueryKey,
  getListInvitationsQueryKey,
  getListMembersQueryKey,
  useCreateInvitation,
  useGetMe,
  useListInvitations,
  useListMembers,
  useRemoveMember,
  useResendInvitation,
  useRevokeInvitation,
  type Invitation,
  type MeResponse,
  type Member,
} from "@workspace/api-client-react";
import { readOf, type Read } from "@/data/todayData";
import { Button, buttonClass } from "@/kit/Button";
import { Note } from "@/kit/Note";
import { Section } from "@/kit/Section";
import { Sheet } from "@/kit/Sheet";
import { SkeletonLine } from "@/kit/Skeleton";
import { StatusWord, type StatusTone } from "@/kit/StatusWord";
import { relativeTime, shortDateOfInstant } from "@/lib/dates";
import { Field, inputClass, useToast } from "@/screens/plan/parts";
import { HouseholdFrame } from "./parts";
import { apiMessage } from "./words";

export interface MembersData {
  me: Read<MeResponse>;
  members: Read<Member[]>;
  invitations: Read<Invitation[]>;
}

const SLOW = { staleTime: 5 * 60_000, gcTime: 30 * 60_000 } as const;

export function useMembersData(): MembersData {
  const me = useGetMe({ query: { queryKey: getGetMeQueryKey(), staleTime: 30 * 60_000, gcTime: 60 * 60_000 } });
  // Only the owner may list members or invitations; a member's request would be a 403.
  const owner = me.data?.isOwner === true;
  const members = useListMembers({ query: { queryKey: getListMembersQueryKey(), enabled: owner, ...SLOW } });
  const invitations = useListInvitations({ query: { queryKey: getListInvitationsQueryKey(), enabled: owner, ...SLOW } });
  return { me: readOf(me), members: readOf(members), invitations: readOf(invitations) };
}

export default function HouseholdMembers() {
  return <MembersView data={useMembersData()} />;
}

const INVITE_WORD: Record<Invitation["status"], { word: string; tone: StatusTone }> = {
  pending: { word: "Waiting", tone: "neutral" },
  accepted: { word: "Joined", tone: "fresh" },
  revoked: { word: "Cancelled", tone: "stale" },
  expired: { word: "Expired", tone: "stale" },
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(ms).toISOString());

/**
 * ⭐ MEMBERS — who is in the household and who has been asked. The owner sees
 * the list, can remove a member, and can invite, resend or cancel an invitation.
 * A member sees only that the owner manages this. Personal allowances are set
 * on Plan.
 */
export function MembersView({ data, now }: { data: MembersData; now?: Date }) {
  const { me, members, invitations } = data;
  const qc = useQueryClient();
  const { say, node: toast } = useToast();
  const create = useCreateInvitation();
  const revoke = useRevokeInvitation();
  const resend = useResendInvitation();
  const removeMember = useRemoveMember();
  const [email, setEmail] = useState("");
  const [tried, setTried] = useState(false);
  const [removing, setRemoving] = useState<Member | null>(null);
  const returnRef = useRef<HTMLElement | null>(null);

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: getListInvitationsQueryKey() });
    void qc.invalidateQueries({ queryKey: getListMembersQueryKey() });
  };

  if (me.state === "cold" && !me.data) {
    return (
      <HouseholdFrame current="members">
        <div className="flex flex-col gap-3" data-testid="members-skeleton" aria-busy="true">
          <SkeletonLine className="w-48" />
          <SkeletonLine className="w-64" />
        </div>
      </HouseholdFrame>
    );
  }

  if (me.state === "failed") {
    return (
      <HouseholdFrame current="members">
        <Note kind="error" onRetry={me.refetch} retrying={me.isFetching}>
          Couldn't load your household.
        </Note>
      </HouseholdFrame>
    );
  }

  const planNote = (
    <p className="type-body text-ink-2" data-testid="allowance-note">
      Personal allowance amounts are set on{" "}
      <Link href="/plan" className={buttonClass({ variant: "link", size: "sm" })}>
        Plan
      </Link>
      .
    </p>
  );

  if (!me.data?.isOwner) {
    return (
      <HouseholdFrame current="members">
        <Section label="You" data-testid="section-you">
          <p className="type-body text-ink" data-testid="member-self">
            {me.data?.displayName || me.data?.email || "You"}
          </p>
          <p className="mt-1 type-caption text-ink-3">Member</p>
        </Section>
        <Section label="The household" data-testid="section-member-view">
          <p className="type-body text-ink-2" data-testid="member-note">
            The household owner manages who is here and who is invited. You can see and change what is yours on the other pages.
          </p>
          <div className="mt-3">{planNote}</div>
        </Section>
      </HouseholdFrame>
    );
  }

  const send = () => {
    setTried(true);
    const e = email.trim();
    if (!EMAIL.test(e)) return;
    create.mutate(
      { data: { email: e } },
      {
        onSuccess: () => {
          setEmail("");
          setTried(false);
          refresh();
          say(`Invitation sent to ${e}.`);
        },
        onError: (err) => say(apiMessage(err, "Couldn't send that invitation. Try again."), "error"),
      },
    );
  };

  const sorted = [...(invitations.data ?? [])].sort((a, b) => b.createdAt - a.createdAt);

  return (
    <HouseholdFrame current="members">
      <Section label="Members" data-testid="section-members">
        {members.state === "failed" ? (
          <Note kind="error" onRetry={members.refetch} retrying={members.isFetching}>
            Couldn't load the members.
          </Note>
        ) : members.data === undefined ? (
          <SkeletonLine className="w-56" />
        ) : (
          <ul className="flex flex-col" data-testid="member-list">
            {members.data.map((m) => {
              const last = relativeTime(iso(m.lastSignInAt), now);
              const self = m.id === me.data?.userId;
              return (
                <li key={m.id} className="flex items-start justify-between gap-3 border-t border-rule py-3 first:border-t-0" data-testid="member-row">
                  <div className="flex min-w-0 flex-col gap-1">
                    <span className="truncate type-body text-ink">
                      {m.displayName || m.email || "Member"}
                      {self ? " (you)" : ""}
                    </span>
                    <span className="truncate type-caption text-ink-3">
                      {m.isOwner ? "Owner" : "Member"}
                      {m.email && m.displayName ? ` · ${m.email}` : ""}
                      {last ? ` · here ${last}` : ""}
                    </span>
                  </div>
                  {!m.isOwner && !self && (
                    <Button
                      size="sm"
                      variant="danger"
                      aria-label={`Remove ${m.displayName || m.email || "member"}`}
                      onClick={(e) => {
                        returnRef.current = e.currentTarget;
                        setRemoving(m);
                      }}
                      data-testid={`remove-member-${m.id}`}
                    >
                      Remove
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="mt-3">{planNote}</div>
      </Section>

      <Section label="Invitations" data-testid="section-invitations">
        <form
          className="flex flex-col gap-3 pb-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
        >
          <Field label="Invite by email" error={tried && !EMAIL.test(email.trim()) ? "Enter an email address, like sam@example.com." : null}>
            {(a) => <input {...a} type="email" autoComplete="off" className={inputClass} value={email} onChange={(e) => setEmail(e.target.value)} data-testid="invite-email" />}
          </Field>
          <Button type="submit" variant="primary" className="self-start" disabled={create.isPending} data-testid="invite-send">
            Send invitation
          </Button>
        </form>
        {invitations.state === "failed" ? (
          <Note kind="error" onRetry={invitations.refetch} retrying={invitations.isFetching}>
            Couldn't load the invitations.
          </Note>
        ) : invitations.data === undefined ? (
          <SkeletonLine className="w-56" />
        ) : sorted.length === 0 ? (
          <Note kind="empty" data-testid="invites-empty">
            No invitations yet.
          </Note>
        ) : (
          <ul className="flex flex-col" data-testid="invite-list">
            {sorted.map((inv) => {
              const w = INVITE_WORD[inv.status];
              const sent = iso(inv.createdAt);
              return (
                <li key={inv.id} className="flex flex-col gap-2 border-t border-rule py-3 first:border-t-0" data-testid="invite-row" data-status={inv.status}>
                  <div className="flex items-start justify-between gap-3">
                    <span className="min-w-0 truncate type-body text-ink">{inv.emailAddress}</span>
                    <StatusWord tone={w.tone}>{w.word}</StatusWord>
                  </div>
                  {sent && <span className="type-caption text-ink-3">Sent {shortDateOfInstant(sent)}</span>}
                  {inv.status === "pending" && (
                    <div className="flex flex-wrap gap-3">
                      <Button
                        size="sm"
                        disabled={resend.isPending}
                        aria-label={`Resend to ${inv.emailAddress}`}
                        onClick={() =>
                          resend.mutate(
                            { id: inv.id },
                            {
                              onSuccess: () => {
                                refresh();
                                say(`Sent again to ${inv.emailAddress}.`);
                              },
                              onError: (err) => say(apiMessage(err, "Couldn't resend. Try again."), "error"),
                            },
                          )
                        }
                        data-testid={`resend-${inv.id}`}
                      >
                        Resend
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        disabled={revoke.isPending}
                        aria-label={`Cancel the invitation to ${inv.emailAddress}`}
                        onClick={() =>
                          revoke.mutate(
                            { id: inv.id },
                            {
                              onSuccess: () => {
                                refresh();
                                say("Invitation cancelled.");
                              },
                              onError: (err) => say(apiMessage(err, "Couldn't cancel that invitation. Try again."), "error"),
                            },
                          )
                        }
                        data-testid={`cancel-${inv.id}`}
                      >
                        Cancel
                      </Button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Section>

      {removing && (
        <Sheet
          open
          onOpenChange={(o) => !o && setRemoving(null)}
          title={`Remove ${removing.displayName || removing.email || "this member"}?`}
          description="They lose access right away and their sign-in is deleted. To bring them back you invite them again."
          returnFocusRef={returnRef}
        >
          <div className="flex flex-col gap-3" data-testid="remove-member-sheet">
            <Button
              variant="danger"
              disabled={removeMember.isPending}
              onClick={() =>
                removeMember.mutate(
                  { id: removing.id },
                  {
                    onSuccess: () => {
                      setRemoving(null);
                      refresh();
                      say("Member removed.");
                    },
                    onError: (err) => say(apiMessage(err, "Couldn't remove that member. Try again."), "error"),
                  },
                )
              }
              data-testid="remove-member-confirm"
            >
              Remove {removing.displayName || removing.email || "member"}
            </Button>
            <Button onClick={() => setRemoving(null)}>Keep them</Button>
          </div>
        </Sheet>
      )}
      {toast}
    </HouseholdFrame>
  );
}
