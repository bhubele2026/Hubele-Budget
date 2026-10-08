import { Page } from "@/ui";
import { PageGrid, Panel } from "@/components/next";

export default function NextForecastPage() {
  return (
    <div data-testid="page-next-forecast">
      <Page title="Forecast" sub="Preview">
        <PageGrid>
          <Panel title="Preview page" span={12}>
            <p className="text-body text-neutral-600">Preview page — the forecast build lands here.</p>
          </Panel>
        </PageGrid>
      </Page>
    </div>
  );
}
