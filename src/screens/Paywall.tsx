import { useNavigate } from "react-router-dom";
import BottomNav from "../components/BottomNav";
import GlassPanel from "../components/GlassPanel";
import Icon from "../components/Icon";
import Logo from "../components/Logo";
import { paywallBenefits } from "../data/mockData";
import { usePremium } from "../state/PremiumContext";
import PREVIEW_IMG from "../assets/dashboard-preview.svg";

export default function Paywall() {
  const navigate = useNavigate();
  const { unlock } = usePremium();

  const startTrial = () => {
    unlock(); // mock — no real payment
    navigate("/film-room");
  };

  return (
    <div className="min-h-screen bg-background pb-32">
      <header className="fixed top-0 z-50 flex h-16 w-full items-center justify-between border-b border-white/10 bg-surface-container/80 px-margin-mobile backdrop-blur-xl md:px-gutter">
        <Logo />
        <button
          onClick={() => navigate(-1)}
          className="rounded-full p-2 text-on-surface-variant transition-colors hover:bg-white/5 active:scale-95"
          aria-label="Close"
        >
          <Icon name="close" />
        </button>
      </header>

      <main className="relative overflow-hidden px-gutter pb-16 pt-24">
        <div className="relative z-10 mx-auto flex max-w-4xl flex-col items-center text-center">
          {/* Visual hook */}
          <div className="relative mb-10">
            <div className="ice-gradient premium-glow animate-float flex h-24 w-24 items-center justify-center rounded-2xl">
              <Icon name="workspace_premium" className="text-5xl text-on-primary-fixed" fill />
            </div>
            <span className="absolute -right-4 -top-4 rounded-full bg-tertiary-container px-3 py-1 font-label-sm text-label-sm uppercase tracking-widest text-on-tertiary-container">
              Elite
            </span>
          </div>

          <span className="mb-3 font-label-md text-label-md uppercase tracking-widest text-tertiary">
            You've seen your rating — here's how to raise it
          </span>
          <h1 className="mb-4 font-headline-xl text-[32px] uppercase leading-tight text-primary md:text-headline-xl">
            Unlock Your Complete AI Film Breakdown
          </h1>
          <p className="mb-12 max-w-xl font-body-lg text-body-lg text-on-surface-variant">
            Turn tonight's mistakes into your next-game game plan — every missed play explained, every fix mapped out.
          </p>

          {/* Benefits */}
          <div className="mb-12 grid w-full grid-cols-1 gap-4 text-left md:grid-cols-2">
            {paywallBenefits.map((benefit) => (
              <GlassPanel
                key={benefit.title}
                className="p-6 transition-all duration-300 hover:border-primary/50"
              >
                <div className="flex items-start gap-4">
                  <div className="rounded-lg bg-primary-container/20 p-3 text-primary">
                    <Icon name={benefit.icon} fill />
                  </div>
                  <div>
                    <h3 className="mb-1 font-headline-md text-headline-md text-on-surface">{benefit.title}</h3>
                    <p className="font-body-md text-on-surface-variant">{benefit.detail}</p>
                  </div>
                </div>
              </GlassPanel>
            ))}
          </div>

          {/* CTAs */}
          <div className="flex w-full max-w-sm flex-col gap-3">
            <p className="font-label-sm text-label-sm text-on-surface-variant">
              Free for 7 days. Cancel anytime — you won't be charged today.
            </p>
            <button
              onClick={startTrial}
              className="ice-gradient premium-glow rounded-xl py-4 font-headline-md text-headline-md uppercase tracking-wide text-on-primary-fixed shadow-lg transition-transform hover:brightness-110 active:scale-95"
            >
              Start My Free Trial
            </button>
            <div className="flex items-center justify-center gap-4 font-label-sm text-label-sm text-on-surface-variant/80">
              <span className="flex items-center gap-1">
                <Icon name="lock" className="text-[14px]" />
                No charge today
              </span>
              <span className="flex items-center gap-1">
                <Icon name="check" className="text-[14px]" />
                Cancel in two taps
              </span>
            </div>
            <button
              onClick={() => navigate("/scorecard")}
              className="mt-1 py-2 font-label-md text-label-md uppercase tracking-widest text-on-surface-variant transition-colors hover:text-on-surface active:opacity-70"
            >
              Continue with Free Scorecard
            </button>
          </div>

          {/* Locked preview */}
          <GlassPanel className="group relative mt-16 aspect-video w-full overflow-hidden rounded-2xl">
            <div
              className="h-full w-full bg-cover bg-center opacity-60 grayscale transition-all duration-700 group-hover:grayscale-0"
              style={{ backgroundImage: `url('${PREVIEW_IMG}')` }}
            />
            <div className="absolute inset-0 bg-gradient-to-t from-background via-transparent to-transparent" />
            <div className="absolute inset-0 flex items-center justify-center">
              <div className="rounded-full border border-white/10 bg-surface-container-highest/60 p-4 backdrop-blur-md transition-transform group-hover:scale-110">
                <Icon name="lock" className="text-4xl text-primary" fill />
              </div>
            </div>
          </GlassPanel>
        </div>
      </main>

      <BottomNav active="insights" />
    </div>
  );
}
