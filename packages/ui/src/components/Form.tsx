import * as React from "react";

export const FormInput = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...rest }, ref) => (
    <input ref={ref} className={["form-input", className ?? ""].filter(Boolean).join(" ")} {...rest} />
  )
);
FormInput.displayName = "FormInput";

export const FormTextarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...rest }, ref) => (
  <textarea ref={ref} className={["form-input", className ?? ""].filter(Boolean).join(" ")} {...rest} />
));
FormTextarea.displayName = "FormTextarea";

export const FormSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(({ className, children, ...rest }, ref) => (
  <select ref={ref} className={["form-input", className ?? ""].filter(Boolean).join(" ")} {...rest}>
    {children}
  </select>
));
FormSelect.displayName = "FormSelect";

export interface ToggleProps {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean | undefined;
}

export function Toggle({ on, onChange, disabled, label }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      disabled={disabled}
      className={["toggle", on ? "on" : ""].filter(Boolean).join(" ")}
      onClick={() => !disabled && onChange(!on)}
    />
  );
}

export interface ToggleRowProps {
  label: string;
  sublabel?: string;
  on: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}

export function ToggleRow({ label, sublabel, on, onChange, disabled }: ToggleRowProps) {
  return (
    <div className="toggle-row">
      <div>
        <div className="toggle-label">{label}</div>
        {sublabel && <div className="toggle-sublabel">{sublabel}</div>}
      </div>
      <Toggle on={on} onChange={onChange} disabled={disabled} label={label} />
    </div>
  );
}
