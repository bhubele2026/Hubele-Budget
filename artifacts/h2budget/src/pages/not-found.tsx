import { Link, Redirect, useLocation, useSearch } from "wouter";
import { Button } from "@/components/ui/button";
import { legacyTarget } from "@/lib/legacyRoutes";

export default function NotFound() {
  // (The switch) A route of the interim app that used to live at `/` lands on
  // the page that holds the same thing here (lib/legacyRoutes.ts). This page is
  // a lazy chunk, so the table never reaches the open path.
  const [location] = useLocation();
  const search = useSearch();
  const to = legacyTarget(location, search);
  if (to) return <Redirect to={to} replace />;
  return (
    <div className="min-h-[62vh] w-full flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <p className="fig text-kpi font-semibold text-neutral-500">404</p>
        <h1 className="mt-2 text-display font-semibold text-foreground">
          This page doesn&apos;t exist.
        </h1>
        <p className="mt-2 text-body text-neutral-600">
          The page you&apos;re looking for isn&apos;t here. Let&apos;s get you
          back somewhere useful.
        </p>
        <div className="mt-5 flex items-center justify-center gap-2">
          <Link href="/home">
            <Button>Take me home</Button>
          </Link>
          <Link href="/banking">
            <Button variant="outline">Go to Banking</Button>
          </Link>
        </div>
      </div>
    </div>
  );
}
