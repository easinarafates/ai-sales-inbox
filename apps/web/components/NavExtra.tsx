// Extra sidebar nav items added by feature modules.
// The styling worker (Worker A) merges these into the Sidebar.
// The features worker (Worker B) appends its new pages here.
// Keep entries in the same shape: href, English label, Bengali label, short sub-label.
// `section` places the item in a Sidebar section (shop | posts | teach |
// help | settings); items without one fall back to Settings.
export type ExtraNavItem = {
  href: string;
  labelEn: string;
  labelBn: string;
  sub: string;
  section?: "shop" | "posts" | "teach" | "help" | "settings";
};

export const EXTRA_NAV: ExtraNavItem[] = [
  { href: "/owner", labelEn: "Owner Panel", labelBn: "ওনার প্যানেল", sub: "Platform control", section: "settings" },
  { href: "/comments", labelEn: "Comments", labelBn: "কমেন্ট", sub: "Moderation", section: "posts" },
  { href: "/saved-replies", labelEn: "Saved replies", labelBn: "সেভ করা উত্তর", sub: "One-tap replies", section: "teach" },
  { href: "/agent-desk", labelEn: "Agent Desk", labelBn: "এজেন্ট ডেস্ক", sub: "AI instructions", section: "teach" },
  { href: "/team", labelEn: "Team", labelBn: "টিম", sub: "Invites & members", section: "settings" },
  { href: "/setup", labelEn: "Setup", labelBn: "সেটআপ", sub: "7-step wizard", section: "settings" },
  { href: "/website-chat", labelEn: "Website chat", labelBn: "ওয়েবসাইট চ্যাট", sub: "Chat widget", section: "teach" },
  { href: "/guide", labelEn: "Guide", labelBn: "গাইড", sub: "How-to steps", section: "help" },
  { href: "/ai-providers", labelEn: "AI Providers", labelBn: "AI প্রোভাইডার", sub: "Groq · ChatGPT · Gemini · Claude", section: "teach" },
];
