import type { ReactNode } from "react";
import Logo from "./Logo";
import AVATAR from "../assets/avatar-coach.svg";
import { AuthActions } from "./AuthActions";

interface TopAppBarProps {
  /** Optional right-side content (e.g. sign in, close button, avatar). */
  actions?: ReactNode;
}

/** Fixed glass top bar shared across screens. */
export default function TopAppBar({ actions }: TopAppBarProps) {
  return (
    <header className="fixed top-0 z-50 flex h-16 w-full items-center justify-between border-b border-white/10 bg-surface-container/80 px-margin-mobile backdrop-blur-xl md:px-gutter">
      <Logo />
      <div className="flex items-center gap-4">
        {actions ?? (
          <>
            <AuthActions />
            <div className="h-8 w-8 overflow-hidden rounded-full border border-primary/20 bg-surface-variant">
              <img src={AVATAR} alt="Your coach profile" className="h-full w-full object-cover" />
            </div>
          </>
        )}
      </div>
    </header>
  );
}
