import { lazy, Suspense } from "react";
import { useLocation } from "wouter";
import AiCost from "./AiCost";

/**
 * Household's two secondary pages behind ONE route importer (`importHouseholdAi`):
 * `/household/ai` renders the AI cost page at once; `/household/automation`
 * loads the Automation screen on demand. The open path has no room for another
 * importer (400 KB cap), and AI cost keeps the single hop it always had.
 */
const Automation = lazy(() => import("./Automation"));

export default function HouseholdMore() {
  const [location] = useLocation();
  if (location.startsWith("/household/automation")) {
    return (
      <Suspense fallback={null}>
        <Automation />
      </Suspense>
    );
  }
  return <AiCost />;
}
