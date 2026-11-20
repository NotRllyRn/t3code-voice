import { MicrophoneTest } from "./MicrophoneTest";
import { useEffect, useState } from "react";
import { useStableCallback } from "../../hooks/useStableCallback";
import { liveVoices, useLiveVoiceSettings } from "../../voice/liveVoiceSettings";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function LiveVoiceSettingsSection() {
  const settings = useLiveVoiceSettings();
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const refresh = useStableCallback(async () => {
    try {
      setDevices(await navigator.mediaDevices.enumerateDevices());
    } catch {
      setDevices([]);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Device enumeration follows browser hardware changes without acquiring a microphone.
  useEffect(() => {
    queueMicrotask(() => void refresh());
    navigator.mediaDevices?.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices?.removeEventListener("devicechange", refresh);
  }, [refresh]);
  const devicePicker = (
    kind: "audioinput" | "audiooutput",
    key: "microphoneId" | "speakerId",
    label: string,
  ) => {
    const choices = devices.filter(
      (device) =>
        device.kind === kind &&
        device.deviceId &&
        device.deviceId !== "default" &&
        device.deviceId !== "communications",
    );
    return (
      <Select
        value={settings[key] || "default"}
        onValueChange={(value) => {
          if (value) useLiveVoiceSettings.setState({ [key]: value === "default" ? "" : value });
        }}
      >
        <SelectTrigger size="sm" aria-label={label}>
          <SelectValue>
            {settings[key]
              ? choices.find((device) => device.deviceId === settings[key])?.label || "Saved device"
              : "System default"}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup align="end" alignItemWithTrigger={false}>
          <SelectItem value="default">System default</SelectItem>
          {choices.map((device, index) => (
            <SelectItem key={device.deviceId} value={device.deviceId}>
              {device.label || `${label} ${index + 1}`}
            </SelectItem>
          ))}
          {settings[key] && !choices.some((device) => device.deviceId === settings[key]) ? (
            <SelectItem value={settings[key]}>Saved device (unavailable)</SelectItem>
          ) : null}
        </SelectPopup>
      </Select>
    );
  };
  return (
    <SettingsSection id="live-voice" title="Live Voice">
      <SettingsRow
        title="Voice"
        description="Used for new Live sessions. Dictation settings are separate."
        control={
          <Select
            value={settings.voice}
            onValueChange={(value) => {
              const voice = liveVoices.find((voice) => voice === value);
              if (voice) useLiveVoiceSettings.setState({ voice });
            }}
          >
            <SelectTrigger size="sm" aria-label="Live voice">
              <SelectValue>{settings.voice}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {liveVoices.map((voice) => (
                <SelectItem key={voice} value={voice}>
                  {voice}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Progress updates"
        description="Announce completed or blocked tasks and requests for attention. Enable to also hear written progress."
        control={
          <Switch
            aria-label="Live voice progress updates"
            checked={settings.notifications === "progress"}
            onCheckedChange={(checked) =>
              useLiveVoiceSettings.setState({ notifications: checked ? "progress" : "terminal" })
            }
          />
        }
      />
      <SettingsRow
        title="Live microphone"
        description="The session keeps this microphone across navigation and reconnects. Device names appear after microphone access is granted."
        control={devicePicker("audioinput", "microphoneId", "Live microphone")}
      />
      {typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype ? (
        <SettingsRow
          title="Live speaker"
          description="Changes apply to the next session."
          control={devicePicker("audiooutput", "speakerId", "Live speaker")}
        />
      ) : null}
      <SettingsRow
        title="Audio devices"
        description="Live continues in the background until you stop it or quit the app."
        control={
          <Button variant="outline" size="sm" onClick={() => void refresh()}>
            Refresh devices
          </Button>
        }
      />
    </SettingsSection>
  );
}

export function MicrophoneTestGate({
  active,
  microphoneId,
  onMicrophoneAccess,
}: {
  active: boolean;
  microphoneId: string;
  onMicrophoneAccess: () => void;
}) {
  return active ? (
    <SettingsRow
      title="Microphone test"
      description="Stop Live voice before testing another microphone."
    />
  ) : (
    <MicrophoneTest
      key={microphoneId}
      microphoneId={microphoneId}
      onMicrophoneAccess={onMicrophoneAccess}
    />
  );
}
