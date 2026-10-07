import { clsx, type ClassValue } from "clsx";

/**
 * Class joining. Plain clsx, deliberately without tailwind-merge: the kit owns
 * every class string, so there is never a caller-supplied class to "win".
 */
export function cx(...inputs: ClassValue[]): string {
  return clsx(inputs);
}
