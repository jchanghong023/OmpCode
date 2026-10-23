import type { OmpTeamMemberSlot } from "@zcode/shared";
import { useZCodeIntl } from "../i18n/index.js";

/** Read-only native slot facts; preserve order, unresolved selectors and duplicates. */
export function SavedMembers({
  title,
  members,
  readState,
}: {
  title: string;
  members: OmpTeamMemberSlot[] | null | undefined;
  readState?: string;
}) {
  const { intl } = useZCodeIntl();
  return (
    <section className="min-w-0 rounded-md bg-surface p-3 text-ui-caption text-foreground-subtle">
      <h3 className="mb-2 flex flex-wrap items-center gap-2 text-ui-caption font-medium">
        {title}
        {readState ? (
          <span className="rounded bg-background px-1.5 py-0.5 text-ui-xs font-normal text-foreground-subtle">
            {intl.formatMessage({ id: `omp.configuration.status.${readState}` })}
          </span>
        ) : null}
      </h3>
      {members === undefined ? (
        <p>{intl.formatMessage({ id: "omp.configuration.unreadable" })}</p>
      ) : members === null ? (
        <p>{intl.formatMessage({ id: "omp.configuration.notConfigured" })}</p>
      ) : members.length === 0 ? (
        <p>{intl.formatMessage({ id: "omp.configuration.emptyFallback" })}</p>
      ) : (
        <ol className="max-h-36 space-y-2 overflow-y-auto">
          {members.map((slot, index) => (
            <li key={index} className="flex min-w-0 gap-2 text-ui-caption">
              <span className="shrink-0 text-foreground-subtlest">{index + 1}.</span>
              <div className="min-w-0">
                <code className="block break-all text-foreground">{slot.rawSelector}</code>
                <span className="break-words text-foreground-subtle">
                  {slot.name ??
                    slot.model?.modelId ??
                    intl.formatMessage({ id: "omp.configuration.unresolved" })}{" "}
                  · {intl.formatMessage({ id: `omp.configuration.status.${slot.status}` })}
                  {slot.reason ? ` · ${slot.reason}` : ""}
                </span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
