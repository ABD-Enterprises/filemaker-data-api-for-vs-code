import type {
  CircuitBreaker,
  CircuitBreakerDiagnostics,
  CircuitBreakerTransition
} from './circuitBreaker';

const MAX_TRANSITIONS_PER_BREAKER = 25;

export interface RegisteredBreaker {
  name: string;
  breaker: CircuitBreaker;
  transitions: CircuitBreakerTransition[];
  registeredAt: number;
}

export interface RegistryEntry {
  name: string;
  diagnostics: CircuitBreakerDiagnostics;
  transitions: CircuitBreakerTransition[];
  registeredAt: number;
}

/**
 * Tracks named CircuitBreaker instances so the user can see their state via
 * the "Show Circuit Breaker Status" command. Transitions are recorded with a
 * bounded ring buffer per breaker.
 */
export class CircuitBreakerRegistry {
  private readonly entries = new Map<string, RegisteredBreaker>();

  public register(name: string, breaker: CircuitBreaker, now = Date.now()): void {
    if (this.entries.has(name)) {
      // Replace prior entry — last writer wins so duplicate jobs don't leak.
      this.unregister(name);
    }
    this.entries.set(name, {
      name,
      breaker,
      transitions: [],
      registeredAt: now
    });
  }

  public recordTransition(name: string, transition: CircuitBreakerTransition): void {
    const entry = this.entries.get(name);
    if (!entry) {
      return;
    }
    entry.transitions.push(transition);
    if (entry.transitions.length > MAX_TRANSITIONS_PER_BREAKER) {
      entry.transitions.splice(0, entry.transitions.length - MAX_TRANSITIONS_PER_BREAKER);
    }
  }

  public unregister(name: string): void {
    this.entries.delete(name);
  }

  public clear(): void {
    this.entries.clear();
  }

  public has(name: string): boolean {
    return this.entries.has(name);
  }

  public size(): number {
    return this.entries.size;
  }

  public list(now = Date.now()): RegistryEntry[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      diagnostics: entry.breaker.getDiagnostics(now),
      transitions: [...entry.transitions],
      registeredAt: entry.registeredAt
    }));
  }
}

export function renderCircuitBreakerStatus(
  entries: RegistryEntry[],
  now = Date.now()
): string {
  if (entries.length === 0) {
    return [
      '# FileMaker Circuit Breaker Status',
      '',
      '_No active circuit breakers._',
      '',
      'Breakers are registered while batch operations are in flight.',
      'If you opened this and expected to see one, the relevant operation has likely already completed.'
    ].join('\n');
  }

  const lines: string[] = ['# FileMaker Circuit Breaker Status', ''];

  for (const entry of entries) {
    const d = entry.diagnostics;
    const ageMs = now - entry.registeredAt;
    lines.push(`## ${entry.name}`);
    lines.push('');
    lines.push(`- **State:** ${d.state.toUpperCase()}`);
    lines.push(`- **Failure count:** ${d.failureCount} / ${d.failureThreshold}`);
    if (d.state === 'open') {
      const seconds = Math.max(0, Math.ceil(d.msUntilHalfOpen / 1000));
      lines.push(`- **Reopens to half-open in:** ${seconds}s`);
    }
    if (d.state === 'half-open') {
      lines.push(
        `- **Half-open successes needed:** ${d.halfOpenSuccessCount} / ${d.halfOpenSuccessThreshold}`
      );
    }
    lines.push(`- **Registered:** ${formatRelative(ageMs)} ago`);
    lines.push('');

    if (entry.transitions.length === 0) {
      lines.push('_No transitions recorded._');
    } else {
      lines.push('### Transitions (most recent last)');
      lines.push('');
      lines.push('| Time | From → To | Reason |');
      lines.push('|---|---|---|');
      for (const t of entry.transitions) {
        const ago = formatRelative(now - t.at);
        lines.push(`| ${ago} ago | \`${t.from}\` → \`${t.to}\` | ${t.reason} |`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

function formatRelative(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  const sec = Math.round(ms / 1_000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  return `${hr}h`;
}
