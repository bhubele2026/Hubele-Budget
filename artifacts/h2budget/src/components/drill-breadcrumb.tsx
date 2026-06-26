import { Link } from "wouter";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";

export type Crumb = { label: string; href?: string };

/**
 * The "back up the drill" affordance shown at the top of every drill
 * destination. The last crumb is the current page (non-link); earlier crumbs
 * are wouter <Link>s. e.g. `Reports / Spending`.
 */
export function DrillBreadcrumb({ items }: { items: Crumb[] }) {
  return (
    <Breadcrumb className="mb-1">
      <BreadcrumbList>
        {items.map((c, i) => {
          const last = i === items.length - 1;
          return (
            <BreadcrumbItem key={`${c.label}-${i}`}>
              {last || !c.href ? (
                <BreadcrumbPage className="text-[11px] uppercase tracking-widest">
                  {c.label}
                </BreadcrumbPage>
              ) : (
                <>
                  <BreadcrumbLink asChild>
                    <Link
                      href={c.href}
                      className="text-[11px] uppercase tracking-widest"
                    >
                      {c.label}
                    </Link>
                  </BreadcrumbLink>
                  <BreadcrumbSeparator />
                </>
              )}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
