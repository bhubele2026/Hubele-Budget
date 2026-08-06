import { Fragment } from "react";
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
          // Separator must be a SIBLING of the item — BreadcrumbSeparator is
          // its own <li>, and nesting it inside BreadcrumbItem (also an <li>)
          // is invalid HTML (React logs a hydration warning on every page).
          return (
            <Fragment key={`${c.label}-${i}`}>
              <BreadcrumbItem>
                {last || !c.href ? (
                  <BreadcrumbPage className="text-[11px] uppercase tracking-widest">
                    {c.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink asChild>
                    <Link
                      href={c.href}
                      className="text-[11px] uppercase tracking-widest"
                    >
                      {c.label}
                    </Link>
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && c.href ? <BreadcrumbSeparator /> : null}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
