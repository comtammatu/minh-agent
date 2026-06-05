import { useId } from "react";
import { Switch } from "@/components/ui/switch";

interface SwitchControlProps {
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

export function SwitchControl({
  label,
  checked,
  onCheckedChange,
}: SwitchControlProps) {
  const id = useId();

  return (
    <div className="flex items-center gap-3">
      <Switch id={id} checked={checked} onCheckedChange={onCheckedChange} />
      <label htmlFor={id} className="text-sm text-muted-foreground">
        {label}
      </label>
    </div>
  );
}
