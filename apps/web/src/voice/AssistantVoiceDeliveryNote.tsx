import type { OrchestrationV2VoiceMessage } from "@t3tools/contracts";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

export function AssistantVoiceDeliveryNote({
  voice,
}: {
  readonly voice: OrchestrationV2VoiceMessage;
}) {
  return (
    <Tooltip>
      <TooltipTrigger render={<p className="mb-1 text-xs text-muted-foreground" />}>
        Generated voice ·{" "}
        {voice.delivery === "drained" ? "audio drained" : `playback ${voice.delivery}`}
      </TooltipTrigger>
      <TooltipPopup>
        Full generated text, not an exact record of words heard or verified coding output.
      </TooltipPopup>
    </Tooltip>
  );
}
