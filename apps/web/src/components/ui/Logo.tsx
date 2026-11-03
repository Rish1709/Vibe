export function Logo({ withWordmark = true }: { withWordmark?: boolean }) {
  return (
    <span className="flex items-center gap-2">
      <img src="/favicon.svg" alt="" className="size-8" />
      {withWordmark && <span className="text-xl font-bold tracking-tight">vibe</span>}
    </span>
  );
}
