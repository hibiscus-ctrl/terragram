// Copyright 2026 Gabriel Ignat
// SPDX-License-Identifier: AGPL-3.0-only

import type * as React from 'react';
import Link from 'next/link';
import { ArrowLeft, ArrowRight } from 'lucide-react';

import { docsFlat } from '@/config/navigation';
import { breadcrumbSchema } from '@/config/structured-data';
import { Prose } from '@/components/content/prose';
import { JsonLd } from '@/components/seo/json-ld';

function PagerLink({ dir, href, label }: { dir: 'prev' | 'next'; href: string; label: string }) {
  const isPrev = dir === 'prev';
  return (
    <Link href={href} className={cnPager(isPrev)}>
      {isPrev && <ArrowLeft className='text-muted-foreground size-4 shrink-0' aria-hidden />}
      <span className={isPrev ? '' : 'text-right'}>
        <span className='text-2xs text-muted-foreground block font-semibold tracking-[0.06em] uppercase'>
          {isPrev ? 'Previous' : 'Next'}
        </span>
        <span className='text-foreground block text-sm font-semibold'>{label}</span>
      </span>
      {!isPrev && <ArrowRight className='text-muted-foreground size-4 shrink-0' aria-hidden />}
    </Link>
  );
}

function cnPager(isPrev: boolean) {
  return [
    'flex items-center gap-3 rounded-xl border border-border bg-card px-4 py-3 transition-colors hover:border-input hover:bg-surface-subtle',
    isPrev ? 'justify-start' : 'justify-end',
  ].join(' ');
}

/**
 * Wraps a doc page: header (eyebrow / title / description), prose body, and
 * prev/next pagination derived from the flat docs order so it never drifts.
 */
export function DocArticle({
  current,
  title,
  description,
  children,
}: {
  current: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  const idx = docsFlat.findIndex((d) => d.href === current);
  const prev = idx > 0 ? docsFlat[idx - 1] : null;
  const next = idx >= 0 && idx < docsFlat.length - 1 ? docsFlat[idx + 1] : null;

  return (
    <article>
      <JsonLd
        data={breadcrumbSchema([
          { name: 'Home', path: '/' },
          { name: 'Documentation', path: '/docs' },
          { name: title, path: current },
        ])}
      />
      <header className='border-border mb-9 border-b pb-7'>
        <p className='text-primary mb-2.5 text-xs font-bold tracking-[0.07em] uppercase'>Documentation</p>
        <h1 className='text-foreground text-[clamp(28px,4vw,34px)] leading-[1.1] font-extrabold tracking-[-0.03em]'>
          {title}
        </h1>
        {description && (
          <p className='text-muted-foreground mt-3.5 text-base leading-[1.5] text-pretty'>{description}</p>
        )}
      </header>

      <Prose>{children}</Prose>

      {(prev || next) && (
        <nav aria-label='Pagination' className='border-border mt-14 grid gap-3 border-t pt-8 sm:grid-cols-2'>
          {prev ? <PagerLink dir='prev' href={prev.href} label={prev.label} /> : <span aria-hidden />}
          {next ? <PagerLink dir='next' href={next.href} label={next.label} /> : <span aria-hidden />}
        </nav>
      )}
    </article>
  );
}
