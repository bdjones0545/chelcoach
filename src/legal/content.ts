/**
 * Legal pages — plain facts about what ChelCoach does with a player's data, written from the
 * code that does it. Keep this in step with the system: retention hours come from
 * server/src/retention/policy.ts, storage from CHELCOACH_MEDIA_STORAGE_MODE, the analysis
 * processor from docs/scotty-remote-provider.md.
 */

/** Set this to a monitored mailbox before public launch. Empty = the contact line is not shown. */
export const LEGAL_CONTACT_EMAIL = "bryan.jones@efficiencystrengthtraining.com";

export const LEGAL_LAST_UPDATED = "2026-09-17";

export type LegalSection = { heading: string; paragraphs: string[]; bullets?: string[] };

export const PRIVACY_SECTIONS: LegalSection[] = [
  {
    heading: "What we collect",
    paragraphs: ["ChelCoach collects only what the coaching flow needs:"],
    bullets: [
      "Account: an email address and a password, handled by Supabase Auth. We never see the password.",
      "Gameplay profile: the platform, control scheme, position, game mode, and (optionally) the jersey number, indicator color and team side you enter on the upload screen.",
      "Gameplay video: the MP4 or MOV clip you upload, and still frames sampled from it.",
      "Coaching reports: the analysis produced for each clip.",
      "We do not collect your real name, gamertag, payment details, or location, and we run no advertising or analytics trackers.",
    ],
  },
  {
    heading: "How your video is used",
    paragraphs: [
      "Your clip is stored privately and used for one thing: producing your coaching report. A small number of frames (at most twelve) are sampled from it and sent to our analysis service, which uses a third-party vision model (currently xAI's Grok) to describe what is visible in those frames. The full video is never sent to the model provider.",
      "Frames shown to you on the confirmation screen are kept only as long as the video is.",
    ],
  },
  {
    heading: "How long we keep it",
    paragraphs: [
      "Uploaded video is deleted automatically 24 hours after upload (48 hours at most, if a job is still running). Your coaching reports remain in your account so you can re-read them. Your gameplay profile is kept until you change it or delete your account.",
    ],
  },
  {
    heading: "Who else processes it",
    paragraphs: ["We use these providers to run the service; each receives only what its role needs:"],
    bullets: [
      "Supabase (authentication, database and file storage; hosted in AWS us-west-2).",
      "Vercel (hosting for the app and its API).",
      "xAI (vision model that reads the sampled frames, via our own analysis gateway).",
      "Cloudflare (network routing between the app and the analysis gateway).",
    ],
  },
  {
    heading: "Your choices",
    paragraphs: [
      "You can cancel an upload before analysis starts, and every report page lets you re-read or ignore its content. To delete your account and everything attached to it, or to ask what we hold about you, contact us.",
    ],
  },
  {
    heading: "Children",
    paragraphs: ["ChelCoach is not directed at children under 13 and we do not knowingly collect their data."],
  },
];

export const TERMS_SECTIONS: LegalSection[] = [
  {
    heading: "The service",
    paragraphs: [
      "ChelCoach analyzes clips of your own EA SPORTS NHL gameplay and produces a coaching report. It is an early-access service offered as-is; features, limits and availability can change, and analysis may be closed at times (the app says so when it is).",
      "ChelCoach is not affiliated with, endorsed by, or sponsored by Electronic Arts or the National Hockey League. NHL and EA SPORTS are trademarks of their owners.",
    ],
  },
  {
    heading: "Your content",
    paragraphs: [
      "You keep ownership of the clips you upload. You give ChelCoach permission to store, sample and analyze them to produce your report, as described in the Privacy Policy. Upload only gameplay you recorded yourself, and nothing that shows other people's personal information.",
    ],
  },
  {
    heading: "Coaching output",
    paragraphs: [
      "Reports are generated from a small sample of frames by an automated system. They are estimates and observations, not measurements, and can be wrong. The Chel Rating is a rubric estimate and is labelled as such. Use the coaching as one input to your own judgment.",
    ],
  },
  {
    heading: "Fair use and limits",
    paragraphs: [
      "Each account has limits on concurrent and daily analyses, and the service has an overall daily capacity. Do not attempt to bypass limits, probe the service, or upload content that is not yours.",
    ],
  },
  {
    heading: "Pricing",
    paragraphs: ["ChelCoach is currently free. There is no subscription, trial or billing. If that changes, it will be stated clearly before anything is charged."],
  },
  {
    heading: "Ending service",
    paragraphs: ["You can stop using ChelCoach at any time and ask for your account to be deleted. We may suspend accounts that break these terms."],
  },
];
