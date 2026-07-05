import { Link } from "react-router-dom";
import Icon from "./Icon";

interface LogoProps {
  to?: string;
  className?: string;
}

/** ChelCoach wordmark + analytics glyph. */
export default function Logo({ to = "/", className = "" }: LogoProps) {
  return (
    <Link to={to} className={`flex items-center gap-3 ${className}`}>
      <Icon name="analytics" className="text-primary text-2xl" fill />
      <span className="font-headline-md text-headline-md font-bold tracking-tighter text-primary">ChelCoach</span>
    </Link>
  );
}
