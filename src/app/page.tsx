export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-2xl flex-1 flex-col justify-center gap-4 px-6 py-24">
      <h1 className="text-3xl font-semibold tracking-tight">RLS Leak Tester</h1>
      <p className="text-muted-foreground">
        Test whether your Postgres and Supabase row-level security policies actually isolate users
        and tenants, in your browser, with a CI-ready proof.
      </p>
    </main>
  );
}
