import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import type { TemplateCard } from "@/lib/site/templates";

interface TemplateCardsProps {
  /** Metadata only (see `templateCards`): the SQL of a template never reaches this page. */
  readonly cards: readonly TemplateCard[];
}

export function TemplateCards({ cards }: TemplateCardsProps) {
  return (
    // Two columns: there are four templates, and three columns left the fourth alone in a row.
    <ul className="grid gap-4 md:grid-cols-2">
      {cards.map((card) => (
        <li
          key={card.id}
          data-testid="template-card"
          className="flex flex-col gap-3 rounded-xl border bg-card p-4 text-card-foreground shadow-xs"
        >
          <div className="flex flex-col gap-1">
            <h3 className="text-base leading-snug font-semibold">{card.title}</h3>
            <p className="font-mono text-xs text-muted-foreground">{card.id}</p>
          </div>
          <p className="flex-1 text-sm leading-relaxed text-muted-foreground">
            <span className="font-medium text-foreground">The leak: </span>
            {card.leak}
          </p>
          {/* Never prefetched: the landing page requests nothing of the lab. */}
          <Button asChild variant="outline" className="self-start">
            <Link
              href={card.href}
              prefetch={false}
              data-testid="template-link"
              aria-label={`Try this template: ${card.title}`}
            >
              Try this template
              <ArrowRight aria-hidden="true" data-icon="inline-end" />
            </Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}
