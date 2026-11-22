/**
 * A point in time, machine-readable in `dateTime` and in the viewer's locale as text. With
 * `relative` (e.g. `3 min ago`) that is what is shown and the exact time moves into the tooltip.
 */
export function TimeStamp({ at, relative }: { at: number; relative?: string }) {
  const exact = new Date(at).toLocaleString();
  return (
    <time dateTime={new Date(at).toISOString()} title={relative ? exact : undefined}>
      {relative ?? exact}
    </time>
  );
}
