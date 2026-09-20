import type { Metadata } from "next";
import { parseLabSearchParams } from "@/lib/lab";
import { LabLoader } from "./lab-loader";
import "./lab.css";

export const metadata: Metadata = {
  title: "Lab",
  description:
    "Paste a schema and personas, run the persona x table x operation matrix against Postgres in your browser, and see which rows leak.",
};

/**
 * The query string is chosen by whoever wrote the link: `parseLabSearchParams` validates it with
 * zod (SEC-002) and falls back to the first template. Nothing of the lab renders on the server;
 * Postgres runs in a Web Worker of this tab and no SQL is sent anywhere.
 */
export default async function LabPage({ searchParams }: Readonly<PageProps<"/lab">>) {
  const entry = parseLabSearchParams(await searchParams);
  return <LabLoader entry={entry} />;
}
