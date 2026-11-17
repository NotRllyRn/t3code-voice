import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";

import { cn } from "~/lib/utils";

import { CommandBlock } from "./CommandBlock";

export function InstallT3Commands({
  command,
  className,
}: {
  readonly command: string;
  readonly className?: string;
}) {
  return (
    <div className={cn("space-y-2", className)}>
      <p className="text-xs text-muted-foreground">
        Install the matching Voice build from the{" "}
        <a href={FORK_DESKTOP.releasesUrl} target="_blank" rel="noreferrer" className="underline">
          fork releases
        </a>{" "}
        using its manual desktop or Docker server instructions. The Docker bundle needs a separate
        pinned Node image and provider CLIs with authentication. Upstream installers and stock
        clients are not compatible.
      </p>
      <p className="text-xs text-muted-foreground">With the matching Voice runtime, run</p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        Use only the command supplied by that Voice build, not an upstream t3 on your PATH.
        Standalone automatic updates are not shipped; follow the release's manual update steps.
      </p>
    </div>
  );
}
