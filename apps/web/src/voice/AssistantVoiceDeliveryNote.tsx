import { T, useGT } from "gt-react";
import type { OrchestrationV2VoiceMessage } from "@t3tools/contracts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

export function AssistantVoiceDeliveryNote({
  voice,
}: {
  readonly voice: OrchestrationV2VoiceMessage;
}) {
  const gt = useGT();
  return (
    <Tooltip>
      <TooltipTrigger render={<p className="mb-1 text-xs text-muted-foreground" />}>
        {voice.delivery === "drained"
          ? gt("Generated voice · audio drained")
          : voice.delivery === "pending"
            ? gt("Generated voice · playback pending")
            : voice.delivery === "interrupted"
              ? gt("Generated voice · playback interrupted")
              : gt("Generated voice · playback unknown")}
      </TooltipTrigger>
      <TooltipPopup>
        <T>Full generated text, not an exact record of words heard or verified coding output.</T>
      </TooltipPopup>
    </Tooltip>
  );
}
