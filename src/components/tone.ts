import type { MetricTone, MomentType } from "../data/mockData";

// Semantic accent colours from the design system:
// tertiary (green) = success, primary (blue) = neutral, error (red) = danger.
export const toneText: Record<MetricTone, string> = {
  good: "text-tertiary",
  warn: "text-primary",
  bad: "text-error",
};

export const toneBar: Record<MetricTone, string> = {
  good: "bg-tertiary",
  warn: "bg-primary",
  bad: "bg-error",
};

export const toneGlow: Record<MetricTone, string> = {
  good: "shadow-[0_0_10px_#4ae176]",
  warn: "shadow-[0_0_10px_#98cbff]",
  bad: "shadow-[0_0_10px_#ffb4ab]",
};

export interface MomentStyle {
  chip: string;
  border: string;
  marker: string;
  markerGlow: string;
}

export const momentStyles: Record<MomentType, MomentStyle> = {
  great: {
    chip: "bg-tertiary-container text-on-tertiary-container",
    border: "border-t-tertiary",
    marker: "bg-tertiary",
    markerGlow: "shadow-[0_0_10px_rgba(74,225,118,0.6)]",
  },
  missed: {
    chip: "bg-error-container text-on-error-container",
    border: "border-t-error",
    marker: "bg-error",
    markerGlow: "shadow-[0_0_10px_rgba(255,180,171,0.6)]",
  },
  breakdown: {
    chip: "bg-error-container text-on-error-container",
    border: "border-t-error",
    marker: "bg-error",
    markerGlow: "shadow-[0_0_10px_rgba(255,180,171,0.6)]",
  },
};
