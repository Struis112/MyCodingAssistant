import Link from "next/link";

// A custom App-Router 404. Required: with `cookies()` used in the root layout
// (dynamic rendering), Next.js would otherwise fall back to its pages-router
// error page when building `/404`, which throws the misleading
// "<Html> should not be imported outside of pages/_document" build error.
export default function NotFound() {
  return (
    <main className="flex h-screen flex-col items-center justify-center gap-3 bg-background text-foreground">
      <h2 className="text-lg font-semibold">Page not found</h2>
      <p className="text-sm text-muted-foreground">That page doesn’t exist.</p>
      <Link href="/" className="text-sm text-primary underline hover:no-underline">
        Back to chat
      </Link>
    </main>
  );
}
