import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

let meData: { isOwner: boolean } | undefined = undefined;
let invitationsData: Array<{
  id: string;
  emailAddress: string;
  status: string;
  createdAt: number;
  updatedAt: number;
}> = [];
let membersData: Array<{
  id: string;
  email: string | null;
  displayName: string | null;
  isOwner: boolean;
  createdAt: number | null;
}> = [];

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@workspace/api-client-react", () => {
  return {
    useGetMe: () => ({ data: meData, isLoading: false }),
    useListInvitations: () => ({
      data: invitationsData,
      isLoading: false,
    }),
    useListMembers: () => ({ data: membersData, isLoading: false }),
    useCreateInvitation: () => ({ mutate: vi.fn(), isPending: false }),
    useRevokeInvitation: () => ({ mutate: vi.fn(), isPending: false }),
    getListInvitationsQueryKey: () => ["/api/invitations"],
    getListMembersQueryKey: () => ["/api/members"],
  };
});

import { OwnerInvitationsSection } from "./owner-invitations";

function renderSection() {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <OwnerInvitationsSection />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  cleanup();
  meData = undefined;
  invitationsData = [];
  membersData = [];
});

describe("OwnerInvitationsSection", () => {
  it("renders nothing for non-owner users", () => {
    meData = { isOwner: false };
    const { container } = renderSection();
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing while /me is loading (no data yet)", () => {
    meData = undefined;
    const { container } = renderSection();
    expect(container.firstChild).toBeNull();
  });

  it("renders invite form, invitations table, and members table for the owner", () => {
    meData = { isOwner: true };
    invitationsData = [
      {
        id: "inv-1",
        emailAddress: "guest@example.com",
        status: "pending",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
      },
    ];
    membersData = [
      {
        id: "u-owner",
        email: "owner@example.com",
        displayName: "Owner",
        isOwner: true,
        createdAt: 1700000000000,
      },
      {
        id: "u-other",
        email: "other@example.com",
        displayName: "Other",
        isOwner: false,
        createdAt: 1700000000001,
      },
    ];
    renderSection();
    expect(screen.getByTestId("card-owner-invitations")).toBeTruthy();
    expect(screen.getByTestId("input-invite-email")).toBeTruthy();
    expect(screen.getByTestId("button-send-invite")).toBeTruthy();
    expect(screen.getByTestId("row-invitation-inv-1")).toBeTruthy();
    expect(screen.getByTestId("button-revoke-inv-1")).toBeTruthy();
    expect(screen.getByTestId("row-member-u-owner")).toBeTruthy();
    expect(screen.getByTestId("badge-owner-u-owner")).toBeTruthy();
    expect(screen.queryByTestId("badge-owner-u-other")).toBeNull();
  });
});
