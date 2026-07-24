import type { MetadataRoute } from "next";
import { docs } from "@/lib/docs";

export default function sitemap(): MetadataRoute.Sitemap {
  return docs.map((doc) => ({
    url: `https://docs.liveprobe.tryastrea.tech/docs/${doc.slug}`,
    changeFrequency: "weekly",
    priority: doc.slug === "quickstart" ? 1 : 0.7,
  }));
}
