import {
  useGetMe,
  useListInvitations,
  useCreateInvitation,
  useRevokeInvitation,
  useResendInvitation,
  useListMembers,
  useRemoveMember,
  getListInvitationsQueryKey,
  getListMembersQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Panel } from "@/components/next";
import { useToast } from "@/hooks/use-toast";
import { Mail, RotateCw, X } from "lucide-react";
import { btn, btnLink, btnLinkDanger, fieldLabel, input, td, th } from "@/ui";

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email"),
});

type InviteFormValues = z.infer<typeof inviteSchema>;

function formatDate(epoch: number | null | undefined): string {
  if (!epoch) return "—";
  try {
    return new Date(epoch).toLocaleDateString();
  } catch {
    return "—";
  }
}

/** (C8) The invitation state as a `.chip` word; the tint only helps. */
function statusChip(status: string): string {
  switch (status) {
    case "accepted":
      return "chip ok";
    case "pending":
      return "chip warn";
    default:
      return "chip gray";
  }
}

export function OwnerInvitationsSection() {
  const { data: me, isLoading: meLoading } = useGetMe();
  const isOwner = me?.isOwner === true;
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const { data: invitations, isLoading: invitesLoading } = useListInvitations({
    query: { enabled: isOwner, queryKey: getListInvitationsQueryKey() },
  });
  const { data: members, isLoading: membersLoading } = useListMembers({
    query: { enabled: isOwner, queryKey: getListMembersQueryKey() },
  });
  const createInvitation = useCreateInvitation();
  const revokeInvitation = useRevokeInvitation();
  const resendInvitation = useResendInvitation();
  const removeMember = useRemoveMember();

  const form = useForm<InviteFormValues>({
    resolver: zodResolver(inviteSchema),
    defaultValues: { email: "" },
  });

  if (meLoading) return null;
  if (!isOwner) return null;

  const onSubmit = (values: InviteFormValues) => {
    createInvitation.mutate(
      { data: { email: values.email } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListInvitationsQueryKey(),
          });
          toast({
            title: "Invitation sent",
            description: `An invite email has been sent to ${values.email}.`,
          });
          form.reset({ email: "" });
        },
        onError: (err) => {
          toast({
            title: "Failed to send invitation",
            description: String(err),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleResend = (id: string, email: string) => {
    resendInvitation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListInvitationsQueryKey(),
          });
          toast({
            title: "Invitation resent",
            description: `A new invite email has been sent to ${email}.`,
          });
        },
        onError: (err) => {
          toast({
            title: "Failed to resend invitation",
            description: String(err),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleRemoveMember = (id: string, label: string) => {
    if (
      !confirm(
        `Remove ${label}'s access to this family budget? They will be signed out and their account will be deleted.`,
      )
    )
      return;
    removeMember.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListMembersQueryKey(),
          });
          toast({ title: "Member removed", description: `${label} no longer has access.` });
        },
        onError: (err) => {
          toast({
            title: "Failed to remove member",
            description: String(err),
            variant: "destructive",
          });
        },
      },
    );
  };

  const handleRevoke = (id: string, email: string) => {
    if (!confirm(`Revoke the pending invitation for ${email}?`)) return;
    revokeInvitation.mutate(
      { id },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({
            queryKey: getListInvitationsQueryKey(),
          });
          toast({ title: "Invitation revoked" });
        },
        onError: (err) => {
          toast({
            title: "Failed to revoke",
            description: String(err),
            variant: "destructive",
          });
        },
      },
    );
  };

  const emailError = form.formState.errors.email?.message;

  // (C8) A Settings › Household panel on the h2budget kit; test ids unchanged.
  return (
    <Panel
      title="Members & invitations"
      sub="Invite-only. Everyone in the household shares the same budget, transactions, debts and connected accounts."
      span={12}
      variant={["static", "flush"]}
      data-testid="card-owner-invitations"
    >
      <form
        onSubmit={form.handleSubmit(onSubmit)}
        className="flex flex-col gap-3 border-b border-brand-line p-4 md:flex-row md:items-end"
        data-testid="form-invite"
        noValidate
      >
        <label className="flex flex-1 flex-col gap-1">
          <span className={fieldLabel}>Email address</span>
          <input
            type="email"
            placeholder="family@example.com"
            autoComplete="off"
            className={input}
            aria-invalid={emailError ? true : undefined}
            data-testid="input-invite-email"
            {...form.register("email")}
          />
          {emailError ? (
            <span className="text-micro text-bad" role="alert">
              {emailError}
            </span>
          ) : null}
        </label>
        <button
          type="submit"
          className={btn}
          disabled={createInvitation.isPending}
          data-testid="button-send-invite"
        >
          <Mail className="mr-1.5 inline h-4 w-4 align-[-3px]" />
          {createInvitation.isPending ? "Sending…" : "Send invite"}
        </button>
      </form>

      <div className="grid gap-0 lg:grid-cols-2 lg:divide-x lg:divide-brand-line">
        <div className="min-w-0">
          <h3 className={`px-4 pt-3 ${fieldLabel}`}>Invitations</h3>
          {invitesLoading ? (
            <div className="skeleton m-4 h-12 rounded-control" />
          ) : (invitations ?? []).length === 0 ? (
            <p className="px-4 py-3 text-body text-neutral-400">No invitations yet.</p>
          ) : (
            <div className="overflow-x-auto" data-testid="table-invitations">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Email</th>
                    <th className={th}>Status</th>
                    <th className={th}>Sent</th>
                    <th className={th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(invitations ?? []).map((inv) => (
                    <tr key={inv.id} data-testid={`row-invitation-${inv.id}`}>
                      <td className={td}>{inv.emailAddress}</td>
                      <td className={td}>
                        <span className={statusChip(inv.status)}>{inv.status}</span>
                      </td>
                      <td className={`${td} font-mono tabular-nums text-neutral-500`}>
                        {formatDate(inv.createdAt)}
                      </td>
                      <td className={`${td} text-right`}>
                        {inv.status === "pending" && (
                          <div className="flex justify-end gap-1">
                            <button
                              type="button"
                              className={btnLink}
                              onClick={() => handleResend(inv.id, inv.emailAddress)}
                              disabled={resendInvitation.isPending}
                              data-testid={`button-resend-${inv.id}`}
                            >
                              <RotateCw className="h-3 w-3" /> Resend
                            </button>
                            <button
                              type="button"
                              className={btnLinkDanger}
                              onClick={() => handleRevoke(inv.id, inv.emailAddress)}
                              disabled={revokeInvitation.isPending}
                              data-testid={`button-revoke-${inv.id}`}
                            >
                              <X className="h-3 w-3" /> Revoke
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="min-w-0">
          <h3 className={`px-4 pt-3 ${fieldLabel}`}>Members</h3>
          {membersLoading ? (
            <div className="skeleton m-4 h-12 rounded-control" />
          ) : (members ?? []).length === 0 ? (
            <p className="px-4 py-3 text-body text-neutral-400">No members yet.</p>
          ) : (
            <div className="overflow-x-auto" data-testid="table-members">
              <table className="w-full">
                <thead>
                  <tr>
                    <th className={th}>Email</th>
                    <th className={th}>Name</th>
                    <th className={th}>Role</th>
                    <th className={th}>Joined</th>
                    <th className={th}>
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {(members ?? []).map((m) => (
                    <tr key={m.id} data-testid={`row-member-${m.id}`}>
                      <td className={td}>{m.email ?? "—"}</td>
                      <td className={`${td} text-neutral-500`}>{m.displayName ?? "—"}</td>
                      <td className={td}>
                        {m.isOwner ? (
                          <span className="chip info" data-testid={`badge-owner-${m.id}`}>
                            Owner
                          </span>
                        ) : (
                          <span className="chip gray">Member</span>
                        )}
                      </td>
                      <td className={`${td} font-mono tabular-nums text-neutral-500`}>
                        {formatDate(m.createdAt)}
                      </td>
                      <td className={`${td} text-right`}>
                        {!m.isOwner && (
                          <button
                            type="button"
                            className={btnLinkDanger}
                            onClick={() =>
                              handleRemoveMember(m.id, m.email ?? m.displayName ?? "this member")
                            }
                            disabled={removeMember.isPending}
                            data-testid={`button-remove-member-${m.id}`}
                          >
                            <X className="h-3 w-3" /> Remove
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Panel>
  );
}
