import emberImage from "../../themes/ember-glass/background.png";
import emberConfig from "../../themes/ember-glass/theme.json";
import neonImage from "../../themes/neon-portal/background.png";
import neonConfig from "../../themes/neon-portal/theme.json";
import paperImage from "../../themes/paper-aurora/background.png";
import paperConfig from "../../themes/paper-aurora/theme.json";
import sparkImage from "../../themes/spark-atelier/background.png";
import sparkConfig from "../../themes/spark-atelier/theme.json";
import sunlitImage from "../../themes/sunlit-spark/background.png";
import sunlitConfig from "../../themes/sunlit-spark/theme.json";
import violetImage from "../../themes/violet-rift/background.png";
import violetConfig from "../../themes/violet-rift/theme.json";

export type PreviewMode = "work" | "code" | "design";
export type AppearanceMode = "light" | "dark";

export interface ThemeColors {
  background: string;
  panel: string;
  panelAlt: string;
  accent: string;
  accentAlt: string;
  secondary: string;
  highlight: string;
  onAccent: string;
  success: string;
  warning: string;
  danger: string;
  info: string;
  disabled: string;
  text: string;
  muted: string;
  line: string;
  selection: string;
  terminal: string;
}

export interface ThemeStates {
  surfaceHover: string;
  surfaceActive: string;
  focus: string;
  tooltipBackground: string;
  tooltipText: string;
}

export interface ThemeVisual {
  motif: "circuit" | "forge" | "editorial" | "collage" | "sketch" | "prism";
  iconTreatment: "outline" | "tile" | "medallion" | "stamp";
  surfaceTreatment: "quiet" | "glass" | "paper" | "layered";
  accentPlacement: "rail" | "corner" | "underline" | "glow";
  cardTreatment: "quiet" | "badge" | "split" | "poster";
  ornament: "none" | "nodes" | "sparks" | "rules" | "tape" | "strokes" | "facets";
}

export interface ThemeAppearance {
  colorScheme: AppearanceMode | "system";
  treatment: string;
  backgroundPosition: string;
  backgroundSize: string;
  backgroundOpacity: number;
  backgroundOverlay: string;
  backgroundBlendMode: string;
  surfaceOpacity: number;
  sidebarOpacity: number;
  blur: number;
  saturation: number;
  radius: number;
  shadow: "soft" | "deep" | "none";
}

export interface StudioTheme {
  id: string;
  name: string;
  description: string;
  layout: "classic" | "studio-collage";
  brandSubtitle: string;
  tagline: string;
  statusText: string;
  quote: string;
  imageUrl: string;
  colors: ThemeColors;
  states: ThemeStates;
  visual: ThemeVisual;
  appearance: ThemeAppearance;
  builtIn: boolean;
  experimental?: boolean;
}

type RawTheme = Omit<StudioTheme, "imageUrl" | "builtIn" | "experimental" | "appearance" | "visual"> & {
  appearance: Partial<ThemeAppearance> & Pick<ThemeAppearance, "colorScheme" | "treatment">;
  visual?: Partial<ThemeVisual>;
};

function createTheme(config: unknown, imageUrl: string, experimental = false): StudioTheme {
  const raw = config as RawTheme;
  return {
    id: raw.id,
    name: raw.name,
    description: raw.description || "",
    layout: raw.layout || "classic",
    brandSubtitle: raw.brandSubtitle || "TRAE DREAM SKIN",
    tagline: raw.tagline || "A calmer workspace.",
    statusText: raw.statusText || "SKIN ACTIVE",
    quote: raw.quote || "BUILD SOMETHING WORTH KEEPING",
    imageUrl,
    colors: raw.colors,
    states: raw.states,
    visual: {
      motif: raw.visual?.motif || "circuit",
      iconTreatment: raw.visual?.iconTreatment || "outline",
      surfaceTreatment: raw.visual?.surfaceTreatment || "quiet",
      accentPlacement: raw.visual?.accentPlacement || "rail",
      cardTreatment: raw.visual?.cardTreatment || "quiet",
      ornament: raw.visual?.ornament || "none",
    },
    appearance: {
      colorScheme: raw.appearance.colorScheme,
      treatment: raw.appearance.treatment,
      backgroundPosition: raw.appearance.backgroundPosition || "center center",
      backgroundSize: raw.appearance.backgroundSize || "cover",
      backgroundOpacity: raw.appearance.backgroundOpacity ?? 1,
      backgroundOverlay: raw.appearance.backgroundOverlay || "rgba(4, 8, 18, 0.28)",
      backgroundBlendMode: raw.appearance.backgroundBlendMode || "normal",
      surfaceOpacity: raw.appearance.surfaceOpacity ?? 0.88,
      sidebarOpacity: raw.appearance.sidebarOpacity ?? 0.84,
      blur: raw.appearance.blur ?? 16,
      saturation: raw.appearance.saturation ?? 1,
      radius: raw.appearance.radius ?? 8,
      shadow: raw.appearance.shadow || "soft",
    },
    builtIn: true,
    experimental,
  };
}

export const BUILT_IN_THEMES: StudioTheme[] = [
  createTheme(sunlitConfig, sunlitImage),
  createTheme(violetConfig, violetImage),
  createTheme(neonConfig, neonImage),
  createTheme(emberConfig, emberImage),
  createTheme(paperConfig, paperImage),
  createTheme(sparkConfig, sparkImage, true),
];
