import { Fragment } from 'react';
import { Link } from 'react-router';

const TOKEN = /(#[\p{L}\p{N}_]+|@[a-z0-9_.]+)/giu;

/**
 * Renders hashtags and mentions as links (or just highlighted, inside another link such as a quoted
 * post, since links can't nest). Text is passed through React as strings, never as HTML, so user
 * content cannot inject markup or scripts.
 */
export function PostText({ text, linkify = true }: { text: string; linkify?: boolean }) {
  const parts = text.split(TOKEN);
  return (
    <p className="text-[15px] leading-relaxed break-words whitespace-pre-line">
      {parts.map((part, index) => {
        if (index % 2 === 0) return <Fragment key={index}>{part}</Fragment>;
        if (!linkify) {
          return (
            <span key={index} className="text-accent">
              {part}
            </span>
          );
        }
        const to = part.startsWith('#')
          ? `/hashtag/${encodeURIComponent(part.slice(1).toLowerCase())}`
          : `/${part.slice(1).toLowerCase()}`;
        return (
          <Link key={index} to={to} className="text-accent hover:underline">
            {part}
          </Link>
        );
      })}
    </p>
  );
}
