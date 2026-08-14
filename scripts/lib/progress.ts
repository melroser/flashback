/**
 * Minimal progress reporting. No dependencies.
 *
 * Writes to stderr so that piping stdout stays clean, and falls back to plain
 * periodic lines when stderr is not a TTY (which is what happens the moment you
 * pipe the command through grep or tee).
 */
/** Evaluated per call rather than captured at import, so stdio can be swapped in tests. */
const isTty = () => Boolean(process.stderr.isTTY);
const BAR_WIDTH = 24;

function fmtDuration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s.padEnd(max, ' ');
  return `${s.slice(0, max - 1)}…`;
}

export class Progress {
  private current = 0;
  private readonly started = Date.now();
  private lastPlainAt = 0;
  private finished = false;

  constructor(
    private readonly label: string,
    private readonly total: number,
  ) {
    if (isTty()) this.render('');
    else process.stderr.write(`${label}: ${total} item(s)\n`);
  }

  /** Advance one step. `detail` is shown inline on a TTY. */
  tick(detail = ''): void {
    this.current++;
    this.render(detail);
  }

  /** Set an absolute position, e.g. when resuming or skipping. */
  set(n: number, detail = ''): void {
    this.current = n;
    this.render(detail);
  }

  private render(detail: string): void {
    if (this.finished) return;
    const frac = this.total > 0 ? Math.min(1, this.current / this.total) : 1;
    const pct = Math.round(frac * 100);
    const elapsed = Date.now() - this.started;

    if (!isTty()) {
      // Plain mode: one line every 2s, plus the final line, so logs stay readable.
      const now = Date.now();
      if (now - this.lastPlainAt < 2000 && this.current < this.total) return;
      this.lastPlainAt = now;
      process.stderr.write(
        `  ${this.label} ${this.current}/${this.total} (${pct}%) ${fmtDuration(elapsed)}\n`,
      );
      return;
    }

    const filled = Math.round(frac * BAR_WIDTH);
    const bar = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
    const eta =
      this.current > 0 && frac < 1
        ? ` eta ${fmtDuration((elapsed / this.current) * (this.total - this.current))}`
        : '';
    const line = `  ${this.label} ${bar} ${String(pct).padStart(3)}%  ${this.current}/${this.total}${eta}  ${truncate(detail, 28)}`;
    process.stderr.write(`\r${line.slice(0, 150)}`);
  }

  /** Clear the bar and print a closing summary line. */
  done(summary = ''): void {
    if (this.finished) return;
    this.finished = true;
    const elapsed = fmtDuration(Date.now() - this.started);
    if (isTty()) process.stderr.write(`\r${' '.repeat(150)}\r`);
    process.stderr.write(`  ${this.label} complete: ${this.current}/${this.total} in ${elapsed}${summary ? ` — ${summary}` : ''}\n`);
  }
}

/** Prints a line without disturbing an active bar. */
export function logAbove(line: string): void {
  if (isTty()) process.stderr.write(`\r${' '.repeat(150)}\r`);
  process.stdout.write(`${line}\n`);
}

/** Countdown spinner for a fixed wait, e.g. the timed disable check. */
export async function waitWithSpinner(ms: number, label: string): Promise<void> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const end = Date.now() + ms;
  let i = 0;
  while (Date.now() < end) {
    if (isTty()) {
      const left = ((end - Date.now()) / 1000).toFixed(1);
      process.stderr.write(`\r  ${frames[i++ % frames.length]} ${label} ${left}s `);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  if (isTty()) process.stderr.write(`\r${' '.repeat(80)}\r`);
}
