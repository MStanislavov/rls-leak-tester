"use client";

/**
 * `ssr: false` is only allowed inside a Client Component in Next.js 16, hence
 * this small wrapper. It keeps PGlite and the worker out of the server render
 * and out of every chunk that another page loads.
 */
import dynamic from "next/dynamic";

const LabSpike = dynamic(() => import("./lab-spike").then((module) => module.LabSpike), {
  ssr: false,
  loading: () => (
    <p data-testid="lab-loading" role="status">
      Loading the lab
    </p>
  ),
});

export function LabLoader() {
  return <LabSpike />;
}
