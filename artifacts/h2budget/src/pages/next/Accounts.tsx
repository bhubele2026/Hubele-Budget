import { Page } from "@/ui";
import { PageGrid, Panel } from "@/components/next";

export default function NextAccountsPage() {
  return (
    <div data-testid="page-next-accounts">
      <Page title="Accounts" sub="Preview">
        <PageGrid>
          <Panel title="Preview page" span={12}>
            <p className="text-body text-neutral-600">Preview page — the accounts build lands here.</p>
          </Panel>
        </PageGrid>
      </Page>
    </div>
  );
}
