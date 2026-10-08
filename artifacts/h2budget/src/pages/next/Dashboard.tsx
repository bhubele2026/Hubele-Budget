import { Page } from "@/ui";
import { PageGrid, Panel } from "@/components/next";

export default function NextDashboardPage() {
  return (
    <div data-testid="page-next-dashboard">
      <Page title="Dashboard" sub="Preview">
        <PageGrid>
          <Panel title="Preview page" span={12}>
            <p className="text-body text-neutral-600">Preview page — the dashboard build lands here.</p>
          </Panel>
        </PageGrid>
      </Page>
    </div>
  );
}
