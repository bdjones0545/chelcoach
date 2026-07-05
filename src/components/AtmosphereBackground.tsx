/** Fixed "darkened arena" atmosphere layer: ice texture + focus vignette. */
export default function AtmosphereBackground() {
  return (
    <div className="pointer-events-none fixed inset-0 z-0">
      <div className="absolute inset-0 bg-surface-dim" />
      <div className="absolute inset-0 ice-texture-overlay" />
      <div className="absolute inset-0 vignette" />
    </div>
  );
}
