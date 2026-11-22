import type { PropsWithChildren } from "react";

import { DocsSidebar } from "@/components/docs/docs-sidebar";

/**
 * Docs shell: the landing-page width (centered 1120px column) with a persistent
 * left sidebar on desktop. On mobile the sidebar collapses into a bordered menu
 * card above the article so the content still leads.
 */
export default function DocsLayout({ children }: PropsWithChildren) {
  return (
    <div className="mx-auto max-w-page px-7 py-10 lg:py-14">
      <div className="lg:grid lg:grid-cols-[212px_minmax(0,1fr)] lg:gap-12">
        <aside className="mb-8 lg:mb-0">
          <div className="rounded-xl border border-border bg-card p-4 lg:sticky lg:top-24 lg:border-0 lg:bg-transparent lg:p-0">
            <DocsSidebar />
          </div>
        </aside>
        {/* A plain div, not <main>: the marketing layout already provides the single
            #main-content <main> landmark this page streams into. A nested <main> would
            create a duplicate landmark and break the skip-to-content target. */}
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
