import Link from "next/link";
import { docsSectionHref } from "@/lib/site/docs";
import { REPO_URL } from "@/lib/site/links";

const LINK_CLASSES = "underline underline-offset-4 hover:text-foreground";

export function SiteFooter() {
  return (
    <footer className="border-t">
      <div className="mx-auto flex w-full max-w-[90rem] flex-col gap-2 px-4 py-6 text-sm text-muted-foreground sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <p>
          Your SQL runs in your browser. The server never executes it.{" "}
          <Link href={docsSectionHref("threat-model")} className={LINK_CLASSES}>
            Threat model and privacy
          </Link>
        </p>
        <p>
          Open source under the{" "}
          <a href={`${REPO_URL}/blob/main/LICENSE`} rel="noreferrer" className={LINK_CLASSES}>
            MIT License
          </a>
        </p>
      </div>
    </footer>
  );
}
