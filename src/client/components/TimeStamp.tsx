/** A point in time, machine-readable in `dateTime` and in the viewer's locale as text. */
export function TimeStamp({ at }: { at: number }) {
  return <time dateTime={new Date(at).toISOString()}>{new Date(at).toLocaleString()}</time>;
}
