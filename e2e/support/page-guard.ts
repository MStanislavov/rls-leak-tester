import type { Page, Request, Response, Worker } from "@playwright/test";

export type E2eMode = "dev" | "prod";

export function e2eMode(): E2eMode {
  return process.env.E2E_MODE === "dev" ? "dev" : "prod";
}

interface CspViolation {
  readonly directive: string;
  readonly blockedUri: string;
  readonly sourceFile: string;
}

declare global {
  interface Window {
    __cspViolations?: CspViolation[];
  }
}

/**
 * Records everything a test needs to claim "nothing went wrong in the browser":
 * console errors, any console line that mentions the Content Security Policy,
 * uncaught page errors, `securitypolicyviolation` events, plus the requests,
 * responses and workers the page produced, and which of those workers the
 * browser has destroyed since.
 */
export class PageGuard {
  readonly consoleProblems: string[] = [];
  readonly pageErrors: string[] = [];
  readonly requests: Request[] = [];
  readonly responses: Response[] = [];
  readonly workers: Worker[] = [];
  /** Workers whose `close` event fired: the browser reports them as terminated. */
  readonly closedWorkers: Worker[] = [];

  private constructor(private readonly page: Page) {}

  static async attach(page: Page): Promise<PageGuard> {
    const guard = new PageGuard(page);
    page.on("console", (message) => {
      const text = message.text();
      if (message.type() === "error" || /content[- ]security[- ]policy/i.test(text)) {
        guard.consoleProblems.push(`[${message.type()}] ${text}`);
      }
    });
    page.on("pageerror", (error) => guard.pageErrors.push(error.message));
    page.on("request", (request) => guard.requests.push(request));
    page.on("response", (response) => guard.responses.push(response));
    page.on("worker", (worker) => {
      guard.workers.push(worker);
      worker.on("close", (closed) => guard.closedWorkers.push(closed));
    });
    // Injected by the browser's automation channel, so the page's CSP does not apply to it.
    await page.addInitScript(() => {
      window.__cspViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.__cspViolations?.push({
          directive: event.effectiveDirective,
          blockedUri: event.blockedURI,
          sourceFile: event.sourceFile,
        });
      });
    });
    return guard;
  }

  async cspViolations(): Promise<CspViolation[]> {
    return this.page.evaluate(() => window.__cspViolations ?? []);
  }

  /**
   * Resolves once React has hydrated the element. React stores its fiber on a hydrated DOM node
   * under a `__reactFiber$<random>` key, so the key is absent on HTML that was only parsed. That
   * is the state a page is left in when the policy blocks Next.js's inline scripts: the markup is
   * there, the flight data never arrives and nothing is hydrated.
   */
  async waitForHydration(selector: string): Promise<void> {
    await this.page.waitForFunction((target) => {
      const element = document.querySelector(target);
      return (
        element !== null && Object.keys(element).some((key) => key.startsWith("__reactFiber$"))
      );
    }, selector);
  }

  requestedUrls(): string[] {
    return this.requests.map((request) => request.url());
  }

  responseFor(url: string): Response | undefined {
    return this.responses.find((response) => response.url() === url);
  }
}

/** Splits a Content-Security-Policy header value into directive name and sources. */
export function parseCsp(header: string): Map<string, string[]> {
  const directives = new Map<string, string[]>();
  for (const part of header.split(";")) {
    const [name, ...sources] = part.trim().split(/\s+/);
    if (name) {
      directives.set(name, sources);
    }
  }
  return directives;
}
