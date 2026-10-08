import { Note } from "@/kit/Note";
import { PlanFrame } from "./parts";

/**
 * The wish list is a later package (its API does not exist yet). This page is
 * a placeholder that says so; it holds no data and builds nothing.
 */
export default function PlanWishlist() {
  return (
    <PlanFrame current="wishlist">
      <div className="flex flex-col gap-4">
        <Note kind="empty" data-testid="wishlist-note">
          Wish list arrives with the next update.
        </Note>
        <p className="type-body text-ink-2" data-testid="afford-note">
          Afford this arrives with the next update.
        </p>
      </div>
    </PlanFrame>
  );
}
