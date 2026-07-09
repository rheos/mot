import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { essayLabel, essaySlugs, getEssay, toBlocks } from '../../../lib/essays';

// A single essay reading page (/essays/[slug]). Session-gated by the middleware. Statically
// generated for the known slugs; an unknown slug 404s.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export function generateStaticParams(): { slug: string }[] {
  return essaySlugs().map((slug) => ({ slug }));
}

export default function EssayPage({ params }: { params: { slug: string } }): React.JSX.Element {
  const essay = getEssay(params.slug);
  if (!essay) notFound();
  const label = essayLabel(params.slug);
  const blocks = toBlocks(essay.body);

  return (
    <main className="mx-auto max-w-2xl px-6 py-14">
      <Link href="/essays" className="text-sm text-ink-3 underline-offset-4 hover:underline">
        ← Essays
      </Link>
      <article className="mt-8">
        <h1 className="font-serif text-3xl leading-tight text-ink">{essay.title}</h1>
        {label ? <p className="mt-2 text-sm text-ink-faint">{label}</p> : null}
        <div className="mt-10">
          {blocks.map((b, i) =>
            b.type === 'hr' ? (
              <hr key={i} className="my-9 border-0 border-t border-hair" />
            ) : (
              <p key={i} className="mb-5 font-serif text-[1.05rem] leading-[1.75] text-ink-2">
                {b.text}
              </p>
            ),
          )}
        </div>
      </article>
    </main>
  );
}
