/// <reference types="vite/client" />
// Isolated component boundary only: no Main IPC, OMP process, model, or user configuration.
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
  IPlatformService,
  Locale,
  OfflineDataBackupSnapshot,
  ZCodeSlashCommand,
} from "@zcode/shared";
import { PlatformProvider } from "../../ui/src/hooks/usePlatform.js";
import { useOfflineDataBackupState } from "../../ui/src/hooks/useOfflineDataBackupState.js";
import { OmpOfflineDataBackupSection } from "../../ui/src/settings/OmpOfflineDataBackupSection.js";
import { ZCodeIntlProvider } from "../../ui/src/i18n/IntlProvider.js";
import { TooltipProvider } from "../../ui/src/components/ui/tooltip.js";
import { OmpProjectIndexPanel } from "../../ui/src/v4/native-tools/OmpProjectIndexPanel.js";
import { OmpOrchestrationPanel } from "../../ui/src/v4/native-tools/OmpOrchestrationPanel.js";
import { applyTheme } from "../../ui/src/useTheme.js";
import { NativeToolsProbe, installNativeToolsFixture } from "./ompNativeTools.fixture.js";
import "../../ui/src/styles.css";

type Snapshot = OfflineDataBackupSnapshot;
type Handler = (snapshot: Snapshot) => void;
interface PendingRead {
  resolve: (snapshot: Snapshot) => void;
  reject: (error: Error) => void;
}

// Deliberately retain removed handlers and pending requests so assertions can deliver stale work.
class MemoryPlatform {
  listeners = new Set<Handler>();
  removed: Handler[] = [];
  reads: PendingRead[] = [];
  order: string[] = [];
  eventOnRead: Snapshot | null = null;
  subscribeError = false;
  service = {
    getOfflineDataBackupState: () => {
      this.order.push("read");
      if (this.eventOnRead) {
        const event = this.eventOnRead;
        this.eventOnRead = null;
        this.emit(event);
      }
      return new Promise<Snapshot>((resolve, reject) => this.reads.push({ resolve, reject }));
    },
    onOfflineDataBackupStateChanged: (handler: Handler) => {
      this.order.push("subscribe");
      if (this.subscribeError) throw new Error("isolated-subscription-failure");
      this.listeners.add(handler);
      return () => {
        this.order.push("unsubscribe");
        this.listeners.delete(handler);
        this.removed.push(handler);
      };
    },
  } as IPlatformService;
  emit(snapshot: Snapshot) {
    for (const handler of this.listeners) handler(snapshot);
  }
}

function HookProbe() {
  const { status, snapshot, isRefreshing, refresh } = useOfflineDataBackupState();
  return (
    <section>
      <output id="hook-state">{JSON.stringify({ status, snapshot, isRefreshing })}</output>
      <button id="hook-refresh" type="button" onClick={refresh}>
        Refresh probe
      </button>
    </section>
  );
}

const root = createRoot(document.getElementById("root")!);
const platforms = new Map<string, MemoryPlatform>();
const unavailable = {} as IPlatformService;
let locale: Locale = "en-US";
let epoch = 0;
const executions: string[] = [];
const catalog: ZCodeSlashCommand[] = [
  "wiki",
  "repo",
  "goal",
  "loop",
  "team",
  "orchestrate",
  "workflowz",
  "fullsend",
].map((name) => ({ name, description: `Isolated ${name}`, source: "builtin" }));

function platform(id: string) {
  let result = platforms.get(id);
  if (!result) {
    result = new MemoryPlatform();
    platforms.set(id, result);
  }
  return result;
}

function mount(
  id: string,
  mode: "hook" | "section" | "native" | "admission" = "hook",
  capabilities = true,
) {
  flushSync(() =>
    root.render(
      <ZCodeIntlProvider key={`${locale}-${epoch}`} initialLocale={locale}>
        <TooltipProvider>
          <PlatformProvider platform={id === "unavailable" ? unavailable : platform(id).service}>
            <main className="min-w-0 bg-background p-4 text-foreground">
              {mode === "admission" ? (
                <NativeToolsProbe />
              ) : mode === "hook" ? (
                <HookProbe />
              ) : mode === "section" ? (
                <section id="offline-section">
                  <OmpOfflineDataBackupSection />
                </section>
              ) : (
                <>
                  <section id="index-panel">
                    <OmpProjectIndexPanel
                      commands={capabilities ? catalog : []}
                      disabled={false}
                      onExecute={execute}
                    />
                  </section>
                  <section id="orchestration-panel" className="mt-6">
                    <OmpOrchestrationPanel
                      commands={capabilities ? catalog : []}
                      disabled={false}
                      onExecute={execute}
                    />
                  </section>
                </>
              )}
            </main>
          </PlatformProvider>
        </TooltipProvider>
      </ZCodeIntlProvider>,
    ),
  );
}
async function execute(text: string): Promise<"sent"> {
  executions.push(text);
  return "sent";
}

const fixture = {
  mount,
  reset(nextLocale: Locale = "en-US", theme: "light" | "dark" = "light") {
    flushSync(() => root.render(null));
    platforms.clear();
    executions.length = 0;
    locale = nextLocale;
    ++epoch;
    applyTheme(theme);
  },
  unmount() {
    flushSync(() => root.render(null));
  },
  setEventOnRead(id: string, snapshot: Snapshot) {
    platform(id).eventOnRead = snapshot;
  },
  setSubscribeError(id: string) {
    platform(id).subscribeError = true;
  },
  resolve(id: string, index: number, snapshot: Snapshot) {
    platform(id).reads[index]!.resolve(snapshot);
  },
  reject(id: string, index: number) {
    platform(id).reads[index]!.reject(new Error("isolated-late-read-failure"));
  },
  emit(id: string, snapshot: Snapshot) {
    platform(id).emit(snapshot);
  },
  emitRemoved(id: string, snapshot: Snapshot) {
    for (const handler of platform(id).removed) handler(snapshot);
  },
  stats(id: string) {
    const source = platform(id);
    return {
      reads: source.reads.length,
      listeners: source.listeners.size,
      removed: source.removed.length,
      order: [...source.order],
    };
  },
  get executions() {
    return [...executions];
  },
};

declare global {
  interface Window {
    productToolsFixture: typeof fixture;
  }
}
window.productToolsFixture = fixture;
installNativeToolsFixture(
  () => mount("admission", "admission"),
  () => fixture.unmount(),
);
