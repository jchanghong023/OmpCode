import { useState } from "react";
import { Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { useZCodeAgentService } from "@/hooks/useZCodeAgentService.js";
import { useZCodeIntl } from "@/i18n/index.js";
import type { OmpConfigurationEntryProps } from "./contract.js";
import { OmpConfigurationPanel } from "./OmpConfigurationPanel.js";

/** Mount only for a real session; draft composers do not acquire a service lease. */
export function OmpConfigurationEntry(target: OmpConfigurationEntryProps) {
  const { intl } = useZCodeIntl();
  const service = useZCodeAgentService(target.workspacePath, undefined, target.workspaceIdentity);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="shrink-0 gap-1.5 text-foreground-subtle hover:text-foreground"
        data-testid="omp-config-open"
        onClick={() => setOpen(true)}
      >
        <Settings2 className="size-3.5" aria-hidden="true" />
        {intl.formatMessage({ id: "omp.configuration.open" })}
      </Button>
      {open ? (
        <OmpConfigurationPanel {...target} service={service} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
