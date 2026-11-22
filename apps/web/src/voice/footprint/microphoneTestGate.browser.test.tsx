import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { MicrophoneTestGate } from "../../components/settings/LiveVoiceSettingsSection";
import "~/index.css";

function microphone() {
  const previous = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");
  const requests: Array<{
    resolve: (stream: MediaStream) => void;
    reject: (error: Error) => void;
  }> = [];
  const getUserMedia = vi.fn(
    () =>
      new Promise<MediaStream>((resolve, reject) => {
        requests.push({ resolve, reject });
      }),
  );
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia },
  });
  return {
    requests,
    getUserMedia,
    [Symbol.dispose]() {
      if (previous) Object.defineProperty(navigator, "mediaDevices", previous);
      else Reflect.deleteProperty(navigator, "mediaDevices");
    },
  };
}

it("keeps the microphone test DOM, focus and local error on unrelated rerenders", async () => {
  using media = microphone();
  const onMicrophoneAccess = vi.fn();
  await using screen = await render(
    <MicrophoneTestGate
      active={false}
      microphoneId="mic-1"
      onMicrophoneAccess={onMicrophoneAccess}
    />,
  );
  const button = screen.getByRole("button", { name: "Record", exact: true });
  const original = button.element();
  await userEvent.click(button);
  await expect.element(screen.getByRole("button", { name: "Stop recording" })).toBeDisabled();
  expect(media.getUserMedia).toHaveBeenCalledWith({ audio: { deviceId: { exact: "mic-1" } } });
  await act(() => media.requests[0]!.reject(new Error("Synthetic microphone denied")));
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Synthetic microphone denied");
  await act(() => (button.element() as HTMLElement).focus());
  await screen.rerender(
    <MicrophoneTestGate active={false} microphoneId="mic-1" onMicrophoneAccess={() => {}} />,
  );
  expect(button.element()).toBe(original);
  await expect.element(button).toHaveFocus();
  await expect.element(screen.getByRole("alert")).toHaveTextContent("Synthetic microphone denied");
  expect(onMicrophoneAccess).not.toHaveBeenCalled();
  expect(media.getUserMedia).toHaveBeenCalledTimes(1);
});

it.each(["live", "device"] as const)(
  "releases a late microphone after %s replaces the test",
  async (replacement) => {
    using media = microphone();
    const onMicrophoneAccess = vi.fn();
    await using screen = await render(
      <MicrophoneTestGate
        active={false}
        microphoneId="mic-1"
        onMicrophoneAccess={onMicrophoneAccess}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Record", exact: true }));
    await expect.element(screen.getByRole("status")).toHaveTextContent("Opening microphone…");
    await screen.rerender(
      <MicrophoneTestGate
        active={replacement === "live"}
        microphoneId={replacement === "device" ? "mic-2" : "mic-1"}
        onMicrophoneAccess={onMicrophoneAccess}
      />,
    );
    if (replacement === "live") {
      await expect.element(screen.getByText("Microphone test", { exact: true })).toBeVisible();
      await expect
        .element(
          screen.getByText("Stop Live voice before testing another microphone.", { exact: true }),
        )
        .toBeVisible();
      expect(screen.container.querySelector("button")).toBeNull();
    } else {
      await expect
        .element(screen.getByRole("button", { name: "Record", exact: true }))
        .toBeEnabled();
      expect(screen.container.querySelector('[role="status"]')).toBeNull();
    }
    const stream = new MediaStream();
    const stop = vi.fn();
    using _tracks = vi
      .spyOn(stream, "getTracks")
      .mockReturnValue([{ stop } as unknown as MediaStreamTrack]);
    await act(() => media.requests[0]!.resolve(stream));
    expect(stop).toHaveBeenCalledOnce();
    expect(onMicrophoneAccess).not.toHaveBeenCalled();
    await screen.rerender(
      <MicrophoneTestGate
        active={false}
        microphoneId="mic-2"
        onMicrophoneAccess={onMicrophoneAccess}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Record", exact: true }));
    expect(media.getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: { exact: "mic-2" } },
    });
    await act(() => media.requests[1]!.reject(new Error("Synthetic retry denied")));
    await expect.element(screen.getByRole("alert")).toHaveTextContent("Synthetic retry denied");
    expect(media.getUserMedia).toHaveBeenCalledTimes(2);
  },
);
