import { useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { HoldButton } from "@/components/ui/hold-button";
import {
  flattenAll,
  isOperatorError,
  pauseAgent,
  resumeAgent,
} from "@/lib/operator-api";

interface OperatorControlsProps {
  globalPaused: boolean;
  disabled?: boolean;
}

export function OperatorControls({
  globalPaused,
  disabled = false,
}: OperatorControlsProps) {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function runAction(
    label: string,
    action: () => Promise<unknown>,
  ): Promise<void> {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const result = await action();
      if (isOperatorError(result)) {
        setError(`${label} failed: ${result.error}`);
        return;
      }
      setMessage(`${label} submitted`);
    } catch (err) {
      setError(
        `${label} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <HoldButton
          holdMs={1500}
          size="sm"
          disabled={disabled || busy}
          onConfirm={() => runAction("Flatten", () => flattenAll())}
        >
          Hold to flatten
        </HoldButton>
        <HoldButton
          holdMs={700}
          size="sm"
          variant="outline"
          disabled={disabled || busy || globalPaused}
          onConfirm={() => runAction("Pause", () => pauseAgent())}
        >
          Hold to pause
        </HoldButton>
        <Button
          size="sm"
          variant="secondary"
          disabled={disabled || busy || !globalPaused}
          onClick={() => void runAction("Resume", () => resumeAgent())}
        >
          Resume
        </Button>
      </div>
      {error ? (
        <Alert variant="destructive" className="max-w-md py-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <p className="text-xs text-muted-foreground">{message}</p>
      ) : null}
    </div>
  );
}
