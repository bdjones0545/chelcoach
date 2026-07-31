import GlassPanel from "../GlassPanel";

export default function SourceMediaNotice({
  available,
  notice,
}: {
  available: boolean;
  notice: string;
}) {
  return (
    <GlassPanel
      className="p-4"
      data-testid="source-media-notice"
      data-media-available={available ? "true" : "false"}
    >
      <p className="font-label-sm uppercase text-on-surface-variant">Source media</p>
      <p className="mt-1 font-body-md text-on-surface">{notice}</p>
    </GlassPanel>
  );
}
