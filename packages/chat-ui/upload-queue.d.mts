import type { Event } from "./bridge";
export class UploadQueue {
  items: Event[];
  error: string;
  running: Promise<void> | null;
  constructor(
    upload: (shot: Event) => Promise<Event>,
    saved: (image: Event) => void,
    changed: (count: number, error: string) => void,
  );
  add(shot: Event): void;
  retry(): void;
  wait(): Promise<void>;
}
