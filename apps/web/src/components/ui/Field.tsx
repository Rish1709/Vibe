import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldShellProps {
  id: string;
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  children: ReactNode;
}

function FieldShell({ id, label, error, hint, children }: FieldShellProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-message`} role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : (
        hint && (
          <div id={`${id}-message`} className="text-sm text-muted">
            {hint}
          </div>
        )
      )}
    </div>
  );
}

const controlClass = (invalid: boolean, extra = '') =>
  `w-full rounded-xl border bg-bg px-3.5 py-2.5 text-[15px] outline-none transition placeholder:text-muted focus:ring-2 focus:ring-accent/40 ${
    invalid ? 'border-danger' : 'border-border focus:border-accent'
  } ${extra}`;

interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
  prefix?: string;
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, prefix, className = '', ...props },
  ref,
) {
  const id = useId();
  const input = (
    <input
      ref={ref}
      id={id}
      aria-invalid={error ? true : undefined}
      aria-describedby={error || hint ? `${id}-message` : undefined}
      className={controlClass(Boolean(error), `${prefix ? 'pl-8' : ''} ${className}`)}
      {...props}
    />
  );
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      {prefix ? (
        <div className="relative">
          <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-muted">
            {prefix}
          </span>
          {input}
        </div>
      ) : (
        input
      )}
    </FieldShell>
  );
});

interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label: string;
  error?: string | undefined;
  hint?: ReactNode;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, error, hint, className = '', ...props },
  ref,
) {
  const id = useId();
  return (
    <FieldShell id={id} label={label} error={error} hint={hint}>
      <textarea
        ref={ref}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error || hint ? `${id}-message` : undefined}
        className={controlClass(Boolean(error), `min-h-24 resize-y ${className}`)}
        {...props}
      />
    </FieldShell>
  );
});
