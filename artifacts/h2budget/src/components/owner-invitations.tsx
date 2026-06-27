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
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import { Mail, RotateCw, X } from "lucide-react";

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

function statusBadgeClasses(status: string): string {
  switch (status) {
    case "accepted":
      return "border-positive/40 text-positive";
    case "pending":
      return "border-warning/40 text-warning";
    case "revoked":
      return "border-muted-foreground/30 text-muted-foreground";
    case "expired":
      return "border-muted-foreground/30 text-muted-foreground";
    default:
      return "border-border text-muted-foreground";
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

  return (
    <Card data-testid="card-owner-invitations">
      <CardHeader>
        <CardTitle>Members &amp; Invitations</CardTitle>
        <CardDescription>
          This app is invite-only. Invite trusted family members by email.
          Everyone in the household shares the same budget, transactions,
          debts and connected accounts — so anything you change here, they
          see, and vice versa.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Form {...form}>
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="flex flex-col md:flex-row md:items-end gap-3"
            data-testid="form-invite"
          >
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem className="flex-1">
                  <FormLabel>Email address</FormLabel>
                  <FormControl>
                    <Input
                      type="email"
                      placeholder="family@example.com"
                      autoComplete="off"
                      data-testid="input-invite-email"
                      {...field}
                    />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button
              type="submit"
              disabled={createInvitation.isPending}
              data-testid="button-send-invite"
            >
              <Mail className="w-4 h-4 mr-2" />
              {createInvitation.isPending ? "Sending..." : "Send invite"}
            </Button>
          </form>
        </Form>

        <div>
          <h3 className="text-sm font-semibold text-foreground mb-2">
            Invitations
          </h3>
          {invitesLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (invitations ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No invitations yet.
            </p>
          ) : (
            <div
              className="rounded-md border border-border overflow-hidden"
              data-testid="table-invitations"
            >
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Email</th>
                    <th className="text-left px-3 py-2 font-medium">Status</th>
                    <th className="text-left px-3 py-2 font-medium">Sent</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {(invitations ?? []).map((inv) => (
                    <tr
                      key={inv.id}
                      className="border-t border-border"
                      data-testid={`row-invitation-${inv.id}`}
                    >
                      <td className="px-3 py-2">{inv.emailAddress}</td>
                      <td className="px-3 py-2">
                        <span
                          className={`text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border ${statusBadgeClasses(inv.status)}`}
                        >
                          {inv.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {formatDate(inv.createdAt)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {inv.status === "pending" && (
                          <div className="flex justify-end gap-1">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                handleResend(inv.id, inv.emailAddress)
                              }
                              disabled={resendInvitation.isPending}
                              data-testid={`button-resend-${inv.id}`}
                            >
                              <RotateCw className="w-3.5 h-3.5 mr-1" /> Resend
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                handleRevoke(inv.id, inv.emailAddress)
                              }
                              disabled={revokeInvitation.isPending}
                              data-testid={`button-revoke-${inv.id}`}
                            >
                              <X className="w-3.5 h-3.5 mr-1" /> Revoke
                            </Button>
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

        <div>
          <h3 className="text-sm font-semibold text-foreground mb-2">
            Members
          </h3>
          {membersLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : (members ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">No members yet.</p>
          ) : (
            <div
              className="rounded-md border border-border overflow-hidden"
              data-testid="table-members"
            >
              <table className="w-full text-sm">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr>
                    <th className="text-left px-3 py-2 font-medium">Email</th>
                    <th className="text-left px-3 py-2 font-medium">Name</th>
                    <th className="text-left px-3 py-2 font-medium">Role</th>
                    <th className="text-left px-3 py-2 font-medium">Joined</th>
                    <th className="px-3 py-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {(members ?? []).map((m) => (
                    <tr
                      key={m.id}
                      className="border-t border-border"
                      data-testid={`row-member-${m.id}`}
                    >
                      <td className="px-3 py-2">{m.email ?? "—"}</td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {m.displayName ?? "—"}
                      </td>
                      <td className="px-3 py-2">
                        {m.isOwner ? (
                          <span
                            className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-primary/40 text-primary"
                            data-testid={`badge-owner-${m.id}`}
                          >
                            Owner
                          </span>
                        ) : (
                          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded border border-border text-muted-foreground">
                            Member
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">
                        {formatDate(m.createdAt)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {!m.isOwner && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              handleRemoveMember(
                                m.id,
                                m.email ?? m.displayName ?? "this member",
                              )
                            }
                            disabled={removeMember.isPending}
                            data-testid={`button-remove-member-${m.id}`}
                          >
                            <X className="w-3.5 h-3.5 mr-1" /> Remove
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
