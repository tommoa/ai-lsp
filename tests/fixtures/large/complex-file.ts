// Large file: complex refactoring scenario

interface Logger {
  info(msg: string): void;
  error(msg: string): void;
}

interface Config {
  defaultThreshold: number;
}

interface DataPoint {
  id: string;
  timestamp: number;
  value: number;
  tags?: string[];
}

interface ProcessingOptions {
  threshold?: number;
  normalize?: boolean;
  aggregate?: boolean;
}

class DataProcessor {
  private logger: Logger;
  private config: Config;
  private cache: Map<string, DataPoint[]>;

  constructor(logger: Logger, config: Config) {
    this.logger = logger;
    this.config = config;
    this.cache = new Map();
  }

  process(data: DataPoint[], options: ProcessingOptions = {}) {
    this.logger.info(`Processing ${data.length} data points`);
    const threshold = options.threshold ?? this.config.defaultThreshold;
    const shouldNormalize = options.normalize ?? false;
    const shouldAggregate = options.aggregate ?? false;

    let processed = data.filter(d => d.value > threshold);
    if (shouldNormalize) {
      processed = this.normalize(processed);
    }
    if (shouldAggregate) {
      processed = this.aggregate(processed);
    }

    return processed;
  }

  normalize(data: DataPoint[]): DataPoint[] {
    const min = Math.min(...data.map(d => d.value));
    const max = Math.max(...data.map(d => d.value));
    const range = max - min;
    return data.map(d => ({
      ...d,
      value: (d.value - min) / range,
    }));
  }

  aggregate(data: DataPoint[]): DataPoint[] {
    const groups = new Map<string, DataPoint[]>();
    for (const point of data) {
      const key = point.id;
      if (!groups.has(key)) {
        groups.set(key, []);
      }
      groups.get(key)!.push(point);
    }

    const result: DataPoint[] = [];
    for (const [id, points] of groups) {
      const sum = points.reduce((a, b) => a + b.value, 0);
      const avg = sum / points.length;
      result.push({
        id,
        timestamp: points[0]!.timestamp,
        value: avg,
      });
    }
    return result;
  }

  clearCache(id?: string) {
    if (id) {
      this.cache.delete(id);
    } else {
      this.cache.clear();
    }
  }
}

export { DataProcessor };
export type { DataPoint, ProcessingOptions };
