// "Legajo listo en dos minutos": the product video, served from the site itself (public/landing/video/).
// It never plays by itself and downloads nothing until the visitor presses play (`preload="none"`), so it
// costs the first render nothing; its English narration is captioned in the picture.
import { SectionShell } from "../../components/Section";
import { useLandingCopy } from "./lang";

export const VIDEO_SOURCE = "/landing/video/legajo-listo.mp4";
export const VIDEO_POSTER = "/landing/video/legajo-listo-poster.jpg";

export function VideoSection() {
  const { video } = useLandingCopy();
  return (
    <SectionShell id="video" eyebrow={video.eyebrow} title={video.title} lead={video.lead} tone="dark">
      <figure data-reveal="" className="mx-auto max-w-tour">
        <video controls preload="none" playsInline poster={VIDEO_POSTER} aria-describedby="video-note" className="aspect-video w-full rounded-panel border border-harbor-700 bg-harbor-900 shadow-float">
          <source src={VIDEO_SOURCE} type="video/mp4" />
          <a href={VIDEO_SOURCE}>{video.fallback}</a>
        </video>
        <figcaption id="video-note" className="mt-4 text-sm text-foam-muted">
          {video.note}
        </figcaption>
      </figure>
    </SectionShell>
  );
}
