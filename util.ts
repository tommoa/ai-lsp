// Utility functions.

export type Level = 'info' | 'warn' | 'error' | 'debug';
export type Log = (
  level: Level,
  message: string,
  extra?: Record<string, any>,
) => void;

export function time(
  log: Log,
  level: Level,
  message: string,
  extra?: Record<string, any>,
) {
  const now = Date.now();
  log(level, message, { status: 'started', ...extra });
  function stop() {
    log(level, message, {
      status: 'completed',
      duration: Date.now() - now,
      ...extra,
    });
  }
  return {
    stop,
    [Symbol.dispose]() {
      stop();
    },
  };
}
