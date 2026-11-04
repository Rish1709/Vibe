import type { StoryGroupDto } from '@vibe/shared';
import { create } from 'zustand';

/**
 * Client-only UI state for the full-screen story viewer: which ring and which story within it.
 * Zustand rather than React Query, because this is not server state; it's where the user is.
 * The groups are a snapshot taken when the viewer opens, so the order doesn't jump around while
 * watching even if the tray refetches and re-sorts underneath.
 */
interface StoryViewerState {
  groups: StoryGroupDto[];
  groupIndex: number;
  storyIndex: number;
  isOpen: boolean;
  open: (groups: StoryGroupDto[], groupIndex: number) => void;
  close: () => void;
  next: () => void;
  previous: () => void;
}

/** Start each ring at its first unseen story, like mainstream apps. */
const firstUnseen = (group: StoryGroupDto | undefined) =>
  Math.max(0, group?.stories.findIndex((story) => !story.viewer.seen) ?? 0);

export const useStoryViewer = create<StoryViewerState>((set, get) => ({
  groups: [],
  groupIndex: 0,
  storyIndex: 0,
  isOpen: false,
  open: (groups, groupIndex) =>
    set({ groups, groupIndex, storyIndex: firstUnseen(groups[groupIndex]), isOpen: true }),
  close: () => set({ isOpen: false }),
  next: () => {
    const { groups, groupIndex, storyIndex } = get();
    const group = groups[groupIndex];
    if (group && storyIndex < group.stories.length - 1) {
      set({ storyIndex: storyIndex + 1 });
    } else if (groupIndex < groups.length - 1) {
      set({ groupIndex: groupIndex + 1, storyIndex: firstUnseen(groups[groupIndex + 1]) });
    } else {
      set({ isOpen: false });
    }
  },
  previous: () => {
    const { groups, groupIndex, storyIndex } = get();
    if (storyIndex > 0) set({ storyIndex: storyIndex - 1 });
    else if (groupIndex > 0) {
      set({
        groupIndex: groupIndex - 1,
        storyIndex: (groups[groupIndex - 1]?.stories.length ?? 1) - 1,
      });
    }
  },
}));
