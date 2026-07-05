import Button from "./Button";
import GlassPanel from "./GlassPanel";
import Icon from "./Icon";

interface Action {
  label: string;
  onClick: () => void;
}

interface StatePanelProps {
  icon: string;
  /** neutral = ice-blue (empty states); error = crimson (failures). */
  tone?: "neutral" | "error";
  title: string;
  message: string;
  primary: Action;
  secondary?: Action;
}

/**
 * Reusable centered panel for empty / error / failure states.
 * Every instance answers: what happened (title), what to do (message),
 * and how to continue (primary / secondary actions).
 */
export default function StatePanel({ icon, tone = "neutral", title, message, primary, secondary }: StatePanelProps) {
  const isError = tone === "error";
  return (
    <GlassPanel className="mx-auto flex max-w-lg flex-col items-center p-8 text-center md:p-10">
      <div
        className={`mb-6 flex h-20 w-20 items-center justify-center rounded-full ${
          isError ? "bg-error/10" : "bg-primary/10"
        }`}
      >
        <Icon name={icon} className={`text-[44px] ${isError ? "text-error" : "text-primary"}`} />
      </div>
      <h2 className="mb-3 font-headline-lg text-headline-lg-mobile uppercase text-on-surface md:text-headline-lg">
        {title}
      </h2>
      <p className="mb-8 max-w-md font-body-md text-on-surface-variant">{message}</p>
      <div className="flex w-full flex-col items-center gap-3 sm:w-auto sm:flex-row">
        <Button className="group w-full sm:w-auto" trailingIcon="arrow_forward" onClick={primary.onClick}>
          {primary.label}
        </Button>
        {secondary && (
          <Button variant="ghost" className="w-full sm:w-auto" onClick={secondary.onClick}>
            {secondary.label}
          </Button>
        )}
      </div>
    </GlassPanel>
  );
}
