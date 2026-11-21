// Shared between the server (which produces these) and the app (which filters them).

export type Chapter = [seconds: number, title: string];

export type Video = {
  id: string;
  title: string;
  channelId: string;
  channel: string;
  published: string; // ISO date
  seconds: number | null; // null = unknown (e.g. an upcoming premiere)
  chapters?: Chapter[];
};

export type ChannelFeed = {
  id: string;
  title: string;
  videos: Video[];
  fetchedAt: number;
};

export type ChannelHit = {
  id: string;
  title: string;
  handle?: string;
  subscribers?: string;
  thumbnail?: string;
};
