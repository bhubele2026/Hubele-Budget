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
