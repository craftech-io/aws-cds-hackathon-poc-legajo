// `/`: the commercial landing of Legajo listo (docs/landing-spec.md, ADR-0016), in Spanish or English.
// It sells the product to a future customer and shows it: the problem, the product video, the product tour over
// operation 4471 with renders built from the product's own components and texts, what it does for
// each party, the guarantees in code, goals (never results), how it integrates, the architecture on AWS, the
// questions, the gallery of real console captures and the closing call to action, in that order (§1.2).
// Its root carries `data-surface="public"` so the motion rules of index.css apply only here and to the
// sign-in screens.
import { useRef } from "react";
import { ClosingSection, Footer } from "./Closing";
import { ArchitectureSection } from "./ArchitectureSection";
import { FaqSection } from "./FaqSection";
import { GalleryProvider } from "./gallery";
import { GallerySection } from "./GallerySection";
import { Header } from "./Header";
import { Hero } from "./Hero";
import { ImpactSection } from "./ImpactSection";
import { IntegrationsSection } from "./IntegrationsSection";
import { LandingLangProvider } from "./lang";
import { useLandingMedia } from "./media";
import { useMediaQuery, useRevealFallback } from "./motion/hooks";
import { MotionProvider, useMotion } from "./motion/MotionContext";
import { CapabilitiesSection, GuaranteesSection, ProblemSection } from "./Sections";
import { TourSection } from "./TourSection";
import { VideoSection } from "./VideoSection";

function LandingPage() {
  const media = useLandingMedia();
  const { animate } = useMotion();
  const wide = useMediaQuery("(min-width: 768px)");
  const root = useRef<HTMLDivElement>(null);
  useRevealFallback(root, animate && media.status !== "loading");
  return (
    <div ref={root} data-surface="public" className="min-h-screen bg-manifest font-sans text-ink">
      <GalleryProvider media={media} viewport={wide ? "desktop" : "mobile"}>
        <Header />
        <main id="main" tabIndex={-1} className="outline-none">
          <Hero />
          <ProblemSection />
          <VideoSection />
          <TourSection />
          <CapabilitiesSection />
          <GuaranteesSection />
          <ImpactSection />
          <IntegrationsSection />
          <ArchitectureSection />
          <FaqSection />
          <GallerySection media={media} />
          <ClosingSection />
        </main>
        <Footer />
      </GalleryProvider>
    </div>
  );
}

export function LandingView() {
  return (
    <LandingLangProvider>
      <MotionProvider>
        <LandingPage />
      </MotionProvider>
    </LandingLangProvider>
  );
}
