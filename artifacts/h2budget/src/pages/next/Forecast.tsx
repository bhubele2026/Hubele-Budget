import { useState } from "react";
import ForecastPage from "../forecast";
import { ForecastBody, type RegisterTab } from "../forecast/ForecastBody";

/**
 * `/next/forecast` — the same screen as `/forecast` and `/review` (C13: one
 * layout, `ForecastBody`), with the two register views switching in place
 * instead of between the routes. The view decides the page's mode, as before.
 */
export default function NextForecastPage() {
  const [tab, setTab] = useState<RegisterTab>("register");
  // Keyed by DATE and held out here, above the data page, so a refetch or a
  // horizon change never drops it.
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  return (
    <div data-testid="page-next-forecast">
      <ForecastPage
        mode={tab === "register" ? "review" : "overall"}
        renderNext={(ctx) => (
          <ForecastBody
            ctx={ctx}
            tab={tab}
            onTab={setTab}
            selectedDate={selectedDate}
            setSelectedDate={setSelectedDate}
            title="Forecast"
          />
        )}
      />
    </div>
  );
}
