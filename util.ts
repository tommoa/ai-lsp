// Utility functions.

export type Level = 'info' | 'warn' | 'error' | 'debug';
export type Log = (level: Level, message: string) => void;
export type Notify = (level: Level, message: string) => void;
