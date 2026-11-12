// Harness-only stand-in for `@clerk/react/internal`.
export function publishableKeyFromHost(_host: string, fallback?: string): string {
  return fallback ?? "pk_test_fixture";
}
export default {};
