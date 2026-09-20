"use client";

/**
 * Sign in with GitHub / sign out, in the site header. The header renders this only when Supabase
 * is configured, so a deployment without it ships none of this code to any page.
 *
 * The auth client (and zod behind it) is loaded after hydration with `import()`: the landing page
 * stays light, and zod's browser configuration (`@/lib/lab/zod-csp`) is in place before the
 * client's schemas are built. What is shown here comes from the session in the browser; what a
 * user may do is decided on the server. The display name is a text node (SEC-001); avatars are
 * not shown because `img-src` does not allow GitHub's image host.
 */
import { LogIn, LogOut } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { authErrorMessage, currentReturnPath } from "@/lib/lab/share-auth";
import type { AuthClient, AuthUser } from "@/lib/store/auth-client";

type AuthView =
  | { readonly status: "loading" }
  | { readonly status: "signed-out" }
  | { readonly status: "signed-in"; readonly user: AuthUser };

function viewOf(user: AuthUser | null): AuthView {
  return user === null ? { status: "signed-out" } : { status: "signed-in", user };
}

export function AuthControls() {
  const router = useRouter();
  const client = useRef<AuthClient | null>(null);
  const [view, setView] = useState<AuthView>({ status: "loading" });
  const [working, setWorking] = useState(false);

  useEffect(() => {
    let active = true;
    let unsubscribe: (() => void) | undefined;
    const start = async (): Promise<void> => {
      await import("@/lib/lab/zod-csp");
      const { getAuthClient } = await import("@/lib/store/auth-client");
      if (!active) {
        return;
      }
      const auth = getAuthClient();
      client.current = auth;
      const user = await auth.getUser().catch(() => null);
      if (!active) {
        return;
      }
      setView(viewOf(user));
      unsubscribe = auth.onAuthStateChange((next) => setView(viewOf(next)));
    };
    void start().catch(() => {
      if (active) {
        setView({ status: "signed-out" });
      }
    });
    const failure = authErrorMessage(window.location.search);
    if (failure !== null) {
      toast.error(failure);
    }
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, []);

  const signIn = (): void => {
    setWorking(true);
    (client.current?.signInWithGitHub(currentReturnPath(window.location)) ?? Promise.resolve())
      .catch(() => toast.error("Sign-in with GitHub could not be started."))
      .finally(() => setWorking(false));
  };

  const signOut = (): void => {
    setWorking(true);
    (client.current?.signOut() ?? Promise.resolve())
      .then(
        () => {
          setView({ status: "signed-out" });
          router.refresh();
        },
        () => toast.error("Sign-out did not complete."),
      )
      .finally(() => setWorking(false));
  };

  if (view.status === "signed-in") {
    return (
      <div className="flex min-w-0 items-center gap-1.5" data-testid="auth-controls">
        <span
          className="hidden max-w-40 truncate text-sm text-muted-foreground sm:inline"
          data-testid="auth-user"
        >
          {view.user.displayName ?? "Signed in"}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={working}
          data-testid="sign-out-button"
          onClick={signOut}
        >
          <LogOut aria-hidden="true" />
          Sign out
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center" data-testid="auth-controls">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={working || view.status === "loading"}
        data-testid="sign-in-button"
        onClick={signIn}
      >
        <LogIn aria-hidden="true" />
        Sign in with GitHub
      </Button>
    </div>
  );
}
