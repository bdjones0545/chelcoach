import { forwardRef } from "react";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import Icon from "./Icon";

type Variant = "primary" | "ghost" | "ice";
type Size = "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  icon?: string;
  trailingIcon?: string;
  children: ReactNode;
}

const base =
  "inline-flex items-center justify-center gap-3 rounded-lg font-headline-md uppercase tracking-wide transition-all active:scale-95 disabled:opacity-50 disabled:pointer-events-none";

const variants: Record<Variant, string> = {
  primary: "bg-primary-container text-on-primary-container hover:brightness-110 glow-effect",
  ice: "ice-gradient text-on-primary-fixed premium-glow hover:brightness-110",
  ghost: "bg-transparent border border-outline/40 text-on-surface hover:bg-white/5",
};

const sizes: Record<Size, string> = {
  md: "px-6 py-3 text-headline-md",
  lg: "px-8 py-4 text-headline-md",
};

/** Primary / ghost / ice CTA button used across the conversion flow. */
const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "primary", size = "lg", icon, trailingIcon, children, className = "", ...rest },
  ref,
) {
  return (
    <button ref={ref} className={`${base} ${variants[variant]} ${sizes[size]} ${className}`} {...rest}>
      {icon && <Icon name={icon} />}
      <span>{children}</span>
      {trailingIcon && <Icon name={trailingIcon} className="transition-transform group-hover:translate-x-1" />}
    </button>
  );
});

export default Button;
