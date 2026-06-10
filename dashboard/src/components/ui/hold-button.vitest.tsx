import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HoldButton } from "@/components/ui/hold-button";

describe("HoldButton", () => {
  it("fires onConfirm after hold duration", async () => {
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });

    const onConfirm = vi.fn();
    render(
      <HoldButton holdMs={700} onConfirm={onConfirm}>
        Hold me
      </HoldButton>,
    );

    const button = screen.getByRole("button", { name: /hold to confirm/i });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });

    const started = performance.now();
    while (frames.length > 0) {
      const cb = frames.shift();
      cb?.(started + 750);
    }

    await waitFor(() => {
      expect(onConfirm).toHaveBeenCalledTimes(1);
    });
  });

  it("does not fire when released early", async () => {
    const onConfirm = vi.fn();
    render(
      <HoldButton holdMs={700} onConfirm={onConfirm}>
        Hold me
      </HoldButton>,
    );

    const button = screen.getByRole("button", { name: /hold to confirm/i });
    fireEvent.pointerDown(button, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(button, { pointerId: 1 });

    await waitFor(() => {
      expect(onConfirm).not.toHaveBeenCalled();
    });
  });
});
