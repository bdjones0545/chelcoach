import type { HTMLAttributes, ReactNode } from "react";

interface GlassPanelProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
}

/** Level-1 elevated surface: glassmorphic panel used for all data cards. */
export default function GlassPanel({ children, className = "", ...rest }: GlassPanelProps) {
  return (
    <div className={`glass-panel rounded-xl ${className}`} {...rest}>
      {children}
    </div>
  );
}
