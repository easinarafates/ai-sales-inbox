/** Customer avatar, shared by the Orders pages (same look as the Inbox):
 * the real photo when Meta gave us one, coloured initials otherwise.
 * The colour comes from a name hash so a customer stays recognisable
 * even without a photo. The initials are only a fallback — never a photo.
 */
const AVATAR_COLORS = [
  "bg-rose-100 text-rose-700",
  "bg-amber-100 text-amber-700",
  "bg-emerald-100 text-emerald-700",
  "bg-sky-100 text-sky-700",
  "bg-violet-100 text-violet-700",
  "bg-orange-100 text-orange-700",
  "bg-teal-100 text-teal-700",
  "bg-indigo-100 text-indigo-700",
];

function avatarColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[hash % AVATAR_COLORS.length] ?? AVATAR_COLORS[0] ?? "bg-slate-100 text-slate-700";
}

export default function CustomerAvatar({ name, pictureUrl, sizeClass }: { name: string; pictureUrl?: string; sizeClass?: string }) {
  const cls = sizeClass ?? "h-10 w-10";
  if (pictureUrl) {
    return <img src={pictureUrl} alt={name} className={`${cls} shrink-0 rounded-full object-cover`} />;
  }
  return (
    <span className={`${cls} flex shrink-0 items-center justify-center rounded-full ${avatarColor(name)} font-bold`}>
      {name.trim().charAt(0) || "?"}
    </span>
  );
}
