let warned = false;

/** One-time warning: `?access_token=` is deprecated (URLs leak into logs); use `POST /live/ticket` or the Authorization header. */
export function warnQueryTokenOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(
    '[llull-server] DEPRECATED: ?access_token= in the URL leaks into access logs; use POST /live/ticket or an Authorization header.',
  );
}
