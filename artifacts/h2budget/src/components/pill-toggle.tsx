import { cn } from "@/lib/utils";

/** A two-option segmented control. Flat, hairline-ringed, navy when chosen. */
export function PillToggle<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string; sub: string }[];
}) {
  return (
    <div className="grid grid-cols-2 gap-1 rounded-control bg-platinum-3 p-1 ring-1 ring-brand-line">
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            aria-pressed={active}
            className={cn(
              "press rounded-control px-3 py-1.5 text-left",
              active ? "bg-brand-navy text-white" : "text-neutral-600 hover:bg-white",
            )}
          >
            <div className="text-body font-semibold leading-tight">{opt.label}</div>
            <div
              className={cn(
                "mt-0.5 text-micro",
                active ? "text-white/70" : "text-neutral-600",
              )}
            >
              {opt.sub}
            </div>
          </button>
        );
      })}
    </div>
  );
}
