import { FORK_DESKTOP } from "@t3tools/shared/forkIdentity";
import { T } from "gt-react";

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
        <T>
          Install the matching Voice build from the{" "}
          <a href={FORK_DESKTOP.releasesUrl} target="_blank" rel="noreferrer" className="underline">
            fork releases
          </a>{" "}
          using its manual desktop or Docker server instructions. The Docker bundle needs a separate
          pinned Node image and provider CLIs with authentication. Upstream installers and stock
          clients are not compatible.
        </T>
      </p>
      <p className="text-xs text-muted-foreground">
        <T>With the matching Voice runtime, run</T>
      </p>
      <CommandBlock command={command} />
      <p className="text-xs text-muted-foreground">
        <T>
          Use only the command supplied by that Voice build, not an upstream t3 on your PATH.
          Standalone automatic updates are not shipped; follow the release's manual update steps.
        </T>
      </p>
    </div>
  );
}
