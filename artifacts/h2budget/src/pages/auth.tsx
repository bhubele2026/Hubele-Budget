import { Redirect } from "wouter";
import { SignIn, SignUp } from "@clerk/react";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

export function SignInPage() {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <SignIn
        path={`${basePath}/sign-in`}
        routing="path"
        signUpUrl={`${basePath}/sign-up`}
      />
    </div>
  );
}

export function SignUpPage() {
  const search = typeof window !== "undefined" ? window.location.search : "";
  const params = new URLSearchParams(search);
  const hasTicket =
    params.has("__clerk_ticket") || params.has("__clerk_invitation_token");
  if (!hasTicket) {
    return <Redirect to="/sign-in" />;
  }
  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <SignUp
        path={`${basePath}/sign-up`}
        routing="path"
        signInUrl={`${basePath}/sign-in`}
      />
    </div>
  );
}
