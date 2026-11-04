import { Fragment } from 'react';

const TOKEN = /(#[\p{L}\p{N}_]+|@[a-z0-9_.]+)/giu;

/**
 * Renders hashtags and mentions as highlighted tokens. Text is passed through React as strings
 * (never as HTML), so user content cannot inject markup or scripts.
 */
export function PostText({ text }: { text: string }) {
  const parts = text.split(TOKEN);
  return (
    <p className="text-[15px] leading-relaxed break-words whitespace-pre-line">
      {parts.map((part, index) =>
        index % 2 === 1 ? (
          <span key={index} className="text-accent">
            {part}
          </span>
        ) : (
          <Fragment key={index}>{part}</Fragment>
        ),
      )}
    </p>
  );
}
