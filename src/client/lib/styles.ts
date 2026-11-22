// Every control (button, select, input, checkbox row) is exactly `h-9`, so a row of mixed controls
// lines up on one baseline whatever its content.
const buttonBase =
  'inline-flex h-9 items-center justify-center whitespace-nowrap rounded-lg px-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';

export const secondaryButtonClass = `${buttonBase} border border-slate-300 bg-white text-slate-700 hover:bg-slate-50`;
export const primaryButtonClass = `${buttonBase} bg-slate-900 text-white hover:bg-slate-800`;
export const dangerButtonClass = `${buttonBase} bg-red-600 text-white hover:bg-red-700`;
export const warningButtonClass = `${buttonBase} bg-amber-600 text-white hover:bg-amber-700`;

const fieldBase = 'block h-9 rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900';
/** A `<select>` or `<input>` under its label. */
export const selectClass = `mt-1 ${fieldBase} disabled:opacity-60`;
export const inputClass = `mt-1 ${fieldBase} w-64 max-w-full`;

/** A checkbox with its text, as tall as the controls next to it. */
export const checkboxLabelClass = 'flex h-9 items-center gap-2 text-sm text-slate-700';

/** A row of controls that share one baseline and wrap onto the next line as a whole. */
export const controlRowClass = 'flex flex-wrap items-end gap-x-4 gap-y-3';
