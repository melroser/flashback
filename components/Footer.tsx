/**
 * The only developer attribution anywhere in the product. A signature, not a
 * funnel: no hire-me, no contact CTA, no newsletter, no portfolio link.
 * The hyperlink is on `film.fyi` alone.
 */
export function Footer() {
  return (
    <footer className="px-4 py-10 text-center text-label uppercase tracking-[0.28em] text-smoke">
      Built with PLUR by{' '}
      <a
        href="https://film.fyi"
        className="text-bone underline decoration-ash underline-offset-4 hover:text-acid"
        rel="noreferrer noopener"
      >
        film.fyi
      </a>
    </footer>
  );
}
