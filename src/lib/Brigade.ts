export type TTaskFn<T> = () => Promise<T>;

export type TReuslt<T> = { result: T | null; err: Error | null };

export class BrigadeDisposedError extends Error {
  constructor(message = 'Brigade is disposed') {
    super(message);
    this.name = 'BrigadeDisposedError';

    // Правильный прототип для корректной работы instanceof
    Object.setPrototypeOf(this, BrigadeDisposedError.prototype);
  }
}

interface PendingTask<T = unknown> {
  fn: TTaskFn<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export default class Brigade {
  private readonly queue: PendingTask[] = [];
  private readonly workers: Promise<void>[] = [];
  private isInitialized = false;
  private isDisposed = false;
  private resolveWaiters: Array<() => void> = [];

  constructor(private readonly workersCount: number) {}

  async init(): Promise<void> {
    if (this.isDisposed) {
      throw new BrigadeDisposedError();
    }

    if (this.isInitialized) {
      return;
    }
    this.isInitialized = true;

    for (let i = 0; i < this.workersCount; i++) {
      this.workers.push(this.spawnWorker());
    }
  }

  async dispose(): Promise<void> {
    if (this.isDisposed) {
      return;
    }
    this.isDisposed = true;
    this.isInitialized = false;

    // Разбудить всех воркеров, чтобы они завершились
    this.notifyWorkers();

    // Отклонить все задачи в очереди
    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (task) {
        task.reject(new BrigadeDisposedError());
      }
    }

    // Дождаться завершения всех воркеров
    await Promise.allSettled(this.workers);
    this.workers.splice(0);
  }

  /**
   * Отдаёт задачи бригаде.
   * Всегда принимает массив (даже одну задачу передавай как [task]).
   * Возвращает Promise, который резолвится результатами в том же порядке,
   * когда ВСЕ переданные задачи будут выполнены воркерами.
   */
  async submitMany<T>(tasks: TTaskFn<T>[]): Promise<TReuslt<T>[]> {
    this.ensureReady();

    if (tasks.length === 0) {
      return [];
    }

    const results: TReuslt<T>[] = new Array(tasks.length);
    const promises = tasks.map((fn, index) => {
      return new Promise<T>((resolve, reject) => {
        this.queue.push({
          fn: fn,
          resolve: (value) => {
            results[index] = { result: value as T, err: null };
            resolve(value as T);
          },
          reject: (err?: unknown) => {
            results[index] = { result: null, err: err as Error };
            reject(err);
          },
        });
      });
    });

    // Разбудить воркеров
    this.notifyWorkers();

    // Ждём завершения именно этого батча
    await Promise.all(promises);
    return results;
  }

  async submit<T>(task: TTaskFn<T>): Promise<TReuslt<T>> {
    const result = await this.submitMany([task]);
    return result[0];
  }

  private ensureReady(): void {
    if (this.isDisposed) {
      throw new Error('Brigade is disposed');
    }
    if (!this.isInitialized) {
      throw new Error('Brigade is not initialized. Call init() first');
    }
  }

  private spawnWorker(): Promise<void> {
    return (async () => {
      while (!this.isDisposed) {
        const task = this.queue.shift();

        if (!task) {
          // Нет задач — ждём, пока появятся
          await this.waitForTask();
          continue;
        }

        try {
          const result = await task.fn();
          task.resolve(result);
        } catch (err) {
          task.reject(err);
        }
      }
    })();
  }

  private waitForTask(): Promise<void> {
    return new Promise((resolve) => {
      this.resolveWaiters.push(resolve);
    });
  }

  private notifyWorkers(): void {
    // Разбудить всех ожидающих воркеров
    const waiters = this.resolveWaiters.splice(0);
    for (const resolve of waiters) {
      resolve();
    }
  }
}

export function logErrors<T>(results: TReuslt<T>[], log: (err: Error) => void): void {
  for (const { err } of results) {
    if (err) {
      log(err);
    }
  }
}
