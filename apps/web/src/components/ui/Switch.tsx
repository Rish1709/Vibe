import { useId } from 'react';

interface SwitchProps {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}

export function Switch({ label, description, checked, disabled, onChange }: SwitchProps) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <label htmlFor={id} className="font-medium">
          {label}
        </label>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition disabled:opacity-50 ${
          checked ? 'bg-accent' : 'bg-surface-hover'
        }`}
      >
        <span
          className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow transition-transform ${
            checked ? 'translate-x-5' : ''
          }`}
        />
      </button>
    </div>
  );
}
