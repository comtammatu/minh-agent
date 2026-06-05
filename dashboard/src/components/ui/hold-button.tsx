import { useCallback, useRef, useState, type ReactNode } from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export interface HoldButtonProps extends Omit<ButtonProps, "onClick"> {
  holdMs?: number;
  onConfirm: () => void | Promise<void>;
  children: ReactNode;
}

export function HoldButton({
  holdMs = 700,
  onConfirm,
  children,
  className,
  disabled,
  variant = "destructive",
  ...props
}: HoldButtonProps) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const frameRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);
  const confirmedRef = useRef(false);

  const stopHold = useCallback(() => {
    if (frameRef.current !== null) {
      cancelAnimationFrame(frameRef.current);
      frameRef.current = null;
    }
    startRef.current = null;
    setHolding(false);
    if (!confirmedRef.current) {
      setProgress(0);
    }
  }, []);

  const finishHold = useCallback(async () => {
    confirmedRef.current = true;
    setProgress(1);
    setHolding(false);
    try {
      await onConfirm();
    } finally {
      window.setTimeout(() => {
        confirmedRef.current = false;
        setProgress(0);
      }, 250);
    }
  }, [onConfirm]);

  const startHold = useCallback(() => {
    if (disabled) return;
    confirmedRef.current = false;
    setHolding(true);
    startRef.current = performance.now();

    const tick = (now: number) => {
      const started = startRef.current;
      if (started === null) return;
      const elapsed = now - started;
      const nextProgress = Math.min(1, elapsed / holdMs);
      setProgress(nextProgress);
      if (nextProgress >= 1) {
        frameRef.current = null;
        void finishHold();
        return;
      }
      frameRef.current = requestAnimationFrame(tick);
    };

    frameRef.current = requestAnimationFrame(tick);
  }, [disabled, finishHold, holdMs]);

  return (
    <Button
      {...props}
      type="button"
      variant={variant}
      disabled={disabled}
      aria-label="Hold to confirm"
      className={cn("relative overflow-hidden", className)}
      onPointerDown={(event) => {
        event.preventDefault();
        if (event.button !== 0) return;
        const target = event.currentTarget;
        if (typeof target.setPointerCapture === "function") {
          target.setPointerCapture(event.pointerId);
        }
        startHold();
      }}
      onPointerUp={(event) => {
        const target = event.currentTarget;
        if (
          typeof target.hasPointerCapture === "function" &&
          target.hasPointerCapture(event.pointerId)
        ) {
          target.releasePointerCapture(event.pointerId);
        }
        stopHold();
      }}
      onPointerLeave={stopHold}
      onPointerCancel={stopHold}
      onKeyDown={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        if (!holding) startHold();
      }}
      onKeyUp={(event) => {
        if (event.key !== " " && event.key !== "Enter") return;
        event.preventDefault();
        stopHold();
      }}
    >
      <span
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-y-0 left-0 bg-white/20 transition-[width] duration-75",
          holding ? "opacity-100" : "opacity-0",
        )}
        style={{ width: `${progress * 100}%` }}
      />
      <span className="relative z-10">{children}</span>
    </Button>
  );
}
