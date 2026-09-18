import { Link } from "react-router-dom";
import AtmosphereBackground from "../components/AtmosphereBackground";
import GlassPanel from "../components/GlassPanel";
import Logo from "../components/Logo";
import { LEGAL_CONTACT_EMAIL, LEGAL_LAST_UPDATED, type LegalSection } from "../legal/content";

export default function LegalPage({ title, sections }: { title: string; sections: LegalSection[] }) {
  return (
    <div className="flex min-h-screen flex-col overflow-x-hidden">
      <AtmosphereBackground />
      <header className="fixed top-0 z-50 flex h-16 w-full items-center justify-between border-b border-white/10 bg-surface-container/80 px-margin-mobile backdrop-blur-xl md:px-gutter">
        <Logo />
      </header>
      <main className="relative z-10 mx-auto w-full max-w-3xl flex-grow px-margin-mobile pb-20 pt-28 md:px-margin-desktop">
        <h1 className="font-headline-xl text-[32px] uppercase text-on-surface md:text-headline-xl">{title}</h1>
        <p className="mt-2 font-label-sm text-label-sm text-on-surface-variant">Last updated {LEGAL_LAST_UPDATED}</p>
        <div className="mt-8 space-y-6">
          {sections.map((s) => (
            <GlassPanel key={s.heading} className="space-y-3 p-6">
              <h2 className="font-headline-md text-headline-md text-on-surface">{s.heading}</h2>
              {s.paragraphs.map((p) => (
                <p key={p} className="font-body-md text-on-surface-variant">
                  {p}
                </p>
              ))}
              {s.bullets && (
                <ul className="list-disc space-y-1 pl-5 font-body-md text-on-surface-variant">
                  {s.bullets.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
            </GlassPanel>
          ))}
          {LEGAL_CONTACT_EMAIL && (
            <p className="font-body-md text-on-surface-variant">
              Contact: <a className="text-primary" href={`mailto:${LEGAL_CONTACT_EMAIL}`}>{LEGAL_CONTACT_EMAIL}</a>
            </p>
          )}
        </div>
        <nav className="mt-10 flex gap-6 font-label-sm text-label-sm text-on-surface-variant">
          <Link to="/privacy" className="hover:text-primary">Privacy Policy</Link>
          <Link to="/terms" className="hover:text-primary">Terms of Service</Link>
          <Link to="/" className="hover:text-primary">Home</Link>
        </nav>
      </main>
    </div>
  );
}
