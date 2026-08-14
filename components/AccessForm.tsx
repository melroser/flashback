'use client';

import { useRef, useState } from 'react';

/**
 * The code form. Server-side verification is the only thing that authorises
 * anything; this component exists so a wrong code renders in-identity instead of
 * dumping raw JSON, and so the single overexposure flash can play on success.
 */
export function AccessForm() {
  const [state, setState] = useState<'idle' | 'checking' | 'wrong' | 'closed' | 'slow' | 'ok'>(
    'idle',
  );
  const [flash, setFlash] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = inputRef.current?.value ?? '';
    if (code.trim().length === 0) return;
    setState('checking');

    let res: Response;
    try {
      res = await fetch('/api/access', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code }),
        redirect: 'manual',
      });
    } catch {
      setState('wrong');
      return;
    }

    // A 303 (or an opaque redirect) means the code was accepted and the session
    // cookie is set.
    if (res.ok || res.status === 303 || res.type === 'opaqueredirect' || res.status === 0) {
      setState('ok');
      // ONE flash, 120ms, never on the failure path. Removed under reduced motion.
      setFlash(true);
      setTimeout(() => {
        window.location.assign('/archive');
      }, 140);
      return;
    }

    if (res.status === 429) setState('slow');
    else if (res.status === 403) setState('closed');
    else setState('wrong');
  }

  const message =
    state === 'wrong'
      ? "That code doesn't work."
      : state === 'closed'
        ? 'This archive is closed.'
        : state === 'slow'
          ? 'Too many tries. Wait a minute.'
          : null;

  return (
    <>
      {flash ? <div className="fx-flash" aria-hidden="true" /> : null}
      <form onSubmit={onSubmit} className="w-full max-w-sm">
        <label
          htmlFor="code"
          className="block text-label uppercase tracking-[0.28em] text-smoke"
        >
          Access code
        </label>
        <input
          ref={inputRef}
          id="code"
          name="code"
          type="text"
          inputMode="text"
          autoComplete="off"
          autoCapitalize="characters"
          spellCheck={false}
          disabled={state === 'checking' || state === 'ok'}
          className="mt-3 w-full border border-ash bg-tar px-4 py-3 text-xl uppercase tracking-[0.3em] text-flash caret-acid placeholder:tracking-normal placeholder:text-smoke/50 focus:border-uv"
          placeholder="••••••••"
        />
        <button
          type="submit"
          disabled={state === 'checking' || state === 'ok'}
          className="mt-4 w-full border border-acid/40 bg-void px-4 py-3 text-label uppercase tracking-[0.28em] text-acid transition-colors hover:bg-acid hover:text-void disabled:opacity-40"
        >
          {state === 'checking' ? 'Checking' : state === 'ok' ? 'Opening' : 'Enter'}
        </button>

        <p aria-live="polite" className="mt-4 min-h-[1.5rem] text-body text-siren">
          {message}
        </p>
      </form>
    </>
  );
}
