import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { Profile } from '../lib/profiles-api.js';
import { secondaryButtonClass } from '../lib/styles.js';
import { useAsyncAction } from '../lib/use-async-action.js';
import type { RulesApi } from '../lib/rules-api.js';
import { useRules } from '../lib/use-rules.js';
import { DeleteRuleDialog } from './DeleteRuleDialog.js';

export interface RuleSyncPanelProps<Dto, Discovery, Create, Update, Result> {
  profile: Profile;
  /** Called after a sync run, which may have halted deletions for approval. */
  onSynced(): Promise<void>;
  /** The calls for the Profile's rules of this kind. */
  rulesApi: RulesApi<Dto, Create, Update, Discovery>;
  /** Shown when the rules or the discoverable containers could not be loaded and the error has no text. */
  loadErrorMessage: string;
  runDryRun(profileId: string): Promise<Result>;
  runSync(profileId: string, force: boolean): Promise<Result>;
  title: string;
  description: string;
  /** Button texts: `preview` (Dry-Run), `sync` and `force` (resync all), with the hint of the latter. */
  labels: { readonly preview: string; readonly sync: string; readonly force: string; readonly forceHint: string };
  deleteDialog: {
    readonly title: string;
    /** What stays in Google, e.g. `contacts`. */
    readonly items: string;
    readonly cleanupLabel: string;
    /** Names the rule, e.g. `Privat → Anna`. */
    readonly ruleLabel: (rule: Dto) => string;
  };
  renderRule(rule: Dto, busy: boolean, onUpdate: (ruleId: string, patch: Update) => void, onDelete: (rule: Dto) => void): ReactNode;
  renderAddForm(discovery: Discovery, busy: boolean, onAdd: (rule: Create) => void): ReactNode;
  renderResult(result: Result, dryRun: boolean): ReactNode;
}

/**
 * The panel of a profile-wide sync (contacts, mail): its rules, a way to add one, the dry-run,
 * sync and force buttons, and the result of the last run. The calendar panel already tells an
 * unconnected Profile to connect both accounts, so this one shows nothing then.
 */
export function RuleSyncPanel<Dto extends { readonly id: string }, Discovery, Create, Update, Result>(
  props: RuleSyncPanelProps<Dto, Discovery, Create, Update, Result>,
) {
  if (!props.profile.appleConnected || !props.profile.googleConnected) {
    return null;
  }
  return <ConnectedRuleSync {...props} />;
}

function ConnectedRuleSync<Dto extends { readonly id: string }, Discovery, Create, Update, Result>({
  profile,
  onSynced,
  rulesApi,
  loadErrorMessage,
  runDryRun,
  runSync,
  title,
  description,
  labels,
  deleteDialog,
  renderRule,
  renderAddForm,
  renderResult,
}: RuleSyncPanelProps<Dto, Discovery, Create, Update, Result>) {
  const { rules, discovery, loadError, add, update, remove } = useRules(rulesApi, profile.id, loadErrorMessage);
  const [result, setResult] = useState<{ value: Result; dryRun: boolean } | null>(null);
  const [deleting, setDeleting] = useState<Dto | null>(null);
  const { busy, error, run, reset } = useAsyncAction();

  useEffect(() => {
    setResult(null);
    setDeleting(null);
    reset();
  }, [profile.id, reset]);

  async function syncNow(force: boolean) {
    setResult({ value: await runSync(profile.id, force), dryRun: false });
    await onSynced();
  }

  return (
    <section className="mt-6 rounded-xl border border-slate-200 bg-white p-6 shadow-xs">
      <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
      <p className="mt-1 text-sm text-slate-600">{description}</p>

      {rules.length > 0 && (
        <ul className="mt-4 space-y-2">
          {rules.map((rule) => (
            <Fragment key={rule.id}>
              {renderRule(rule, busy, (ruleId, patch) => void run(() => update(ruleId, patch)), setDeleting)}
            </Fragment>
          ))}
        </ul>
      )}

      {discovery && renderAddForm(discovery, busy, (rule) => void run(() => add(rule)))}

      <div className="mt-5 flex flex-wrap gap-2">
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          onClick={() => void run(async () => setResult({ value: await runDryRun(profile.id), dryRun: true }))}
        >
          {labels.preview}
        </button>
        <button type="button" disabled={busy} className={secondaryButtonClass} onClick={() => void run(() => syncNow(false))}>
          {labels.sync}
        </button>
        <button
          type="button"
          disabled={busy}
          className={secondaryButtonClass}
          title={labels.forceHint}
          onClick={() => void run(() => syncNow(true))}
        >
          {labels.force}
        </button>
      </div>

      {(error ?? loadError) && (
        <p role="alert" className="mt-4 text-sm text-red-700">
          {error ?? loadError}
        </p>
      )}
      {result && renderResult(result.value, result.dryRun)}

      {deleting && (
        <DeleteRuleDialog
          title={deleteDialog.title}
          ruleLabel={deleteDialog.ruleLabel(deleting)}
          items={deleteDialog.items}
          cleanupLabel={deleteDialog.cleanupLabel}
          busy={busy}
          onCancel={() => setDeleting(null)}
          onConfirm={(cleanupGoogle) =>
            void run(async () => {
              await remove(deleting.id, cleanupGoogle);
              setDeleting(null);
            })
          }
        />
      )}
    </section>
  );
}
