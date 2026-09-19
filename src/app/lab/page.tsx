import type { Metadata } from "next";
import { LabLoader } from "./lab-loader";

export const metadata: Metadata = {
  title: "Lab | RLS Leak Tester",
};

export default function LabPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-12">
      <h1 className="text-2xl font-semibold tracking-tight">Lab</h1>
      <p className="text-muted-foreground">
        Postgres runs inside this browser tab, in a Web Worker. Nothing on this page is sent to a
        server.
      </p>
      <LabLoader />
    </main>
  );
}
