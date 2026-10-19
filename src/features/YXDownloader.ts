/**
 * Скрипт для скачивания файлов/папок с Яндекс.Диска
 * Запуск: npx tsx yadisk-download.ts
 */

import { createWriteStream } from 'node:fs';
import { mkdir, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import Brigade from '../lib/Brigade';

interface Link {
  href: string;
  method: string;
  templated: boolean;
}

interface Resource {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size?: number;
  mime_type?: string;
  _embedded?: {
    items: Resource[];
    limit: number;
    offset: number;
    total: number;
  };
}

export interface FolderNode {
  name: string;
  path: string;
  filesCount: number; // количество файлов прямо в этой папке
  children: FolderNode[]; // вложенные папки
}

process.env.yxdisktoken;

export default class YXDownloader {
  private readonly brigade = new Brigade(100);

  constructor(
    private readonly token: string,
    private readonly apiBase: string = 'https://cloud-api.yandex.net/v1/disk',
  ) {}

  failedFiles: string[] = [];
  successFiles: string[] = [];

  async init() {
    this.brigade.init();
  }

  async apiGet<T>(endpoint: string, params: Record<string, string> = {}): Promise<T> {
    const url = new URL(`${this.apiBase}${endpoint}`);
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }

    const res = await fetch(url, {
      headers: {
        Authorization: `OAuth ${this.token}`,
        Accept: 'application/json',
      },
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`API error ${res.status}: ${text}`);
    }

    return res.json() as Promise<T>;
  }

  /**
   * Рекурсивно собирает структуру папок + количество файлов в каждой.
   * Сами файлы не скачиваются и не сохраняются — только метаданные.
   */
  async fetchStructure(diskPath: string = '/'): Promise<FolderNode> {
    const items = await this.listFolder(diskPath);

    const files = items.filter((i) => i.type === 'file');
    const dirs = items.filter((i) => i.type === 'dir');

    const children: FolderNode[] = [];
    for (const dir of dirs) {
      // Рекурсивно обходим каждую подпапку
      const child = await this.fetchStructure(dir.path);
      children.push(child);
    }

    // Сортируем папки по имени для удобства
    children.sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    return {
      name: diskPath === '/' ? '/' : diskPath.split('/').pop() || diskPath,
      path: diskPath,
      filesCount: files.length,
      children,
    };
  }

  /** Получить прямую ссылку на скачивание файла */
  async getDownloadLink(diskPath: string): Promise<string> {
    const data = await this.apiGet<Link>('/resources/download', {
      path: diskPath,
    });
    return data.href;
  }

  /** Скачать один файл */
  async downloadFile(diskPath: string, localPath: string): Promise<void> {
    console.log(`↓ ${diskPath} → ${localPath}`);

    const MAX_RETRIES = 5;
    const SPEED_BYTES_PER_SEC = 50 * 1024;
    const TIMEOUT_BUFFER_SEC = 10; // запас на установку соединения и т.п.

    let lastError: unknown = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        // 1. Узнаём размер файла, чтобы посчитать timeout
        const meta = await this.apiGet<{ size?: number }>('/resources', {
          path: diskPath,
          fields: 'size',
        });
        const size = meta.size ?? 0;

        // timeout = время на скачивание + небольшой буфер
        // если размер неизвестен — ставим 10 минут
        const timeoutMs =
          size > 0
            ? Math.ceil((size / SPEED_BYTES_PER_SEC + TIMEOUT_BUFFER_SEC) * 1000)
            : 10 * 60 * 1000;

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const href = await this.getDownloadLink(diskPath);

          const res = await fetch(href, {
            headers: {
              Authorization: `OAuth ${this.token}`,
            },
            redirect: 'follow',
            signal: controller.signal,
          });

          if (!res.ok) {
            // 429 Too Many Requests — можно ретраить
            if (res.status === 429) {
              throw Object.assign(new Error(`HTTP 429 Too Many Requests`), {
                retryable: true,
              });
            }
            // остальные HTTP-ошибки — без ретраев
            throw Object.assign(new Error(`HTTP ${res.status}`), {
              retryable: false,
            });
          }

          await mkdir(dirname(localPath), { recursive: true });
          const fileStream = createWriteStream(localPath);
          // @ts-ignore
          await pipeline(Readable.fromWeb(res.body as any), fileStream);

          console.log(`✓ Готово: ${localPath}`);
          this.successFiles.push(localPath);
          return; // успех — выходим
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        lastError = err;
        const message = err instanceof Error ? err.message : String(err);
        const lower = message.toLowerCase();

        // Timeout (AbortError) — НЕ ретраим
        const isTimeout =
          err instanceof Error && (err.name === 'AbortError' || message.includes('aborted'));

        // Явно помеченные как retryable или 429
        const isRetryable =
          !isTimeout &&
          ((err as any)?.retryable === true ||
            lower.includes('429') ||
            lower.includes('too many requests') ||
            lower.includes('fetch failed') ||
            lower.includes('terminated') ||
            lower.includes('network') ||
            lower.includes('econnreset') ||
            lower.includes('etimedout') ||
            lower.includes('enotfound') ||
            lower.includes('econnrefused') ||
            lower.includes('socket hang up'));

        if (isTimeout) {
          console.error(
            `✗ Таймаут при скачивании ${diskPath} (превышена ожидаемая скорость ${SPEED_BYTES_PER_SEC / 1024} КБ/с)`,
          );
          this.failedFiles.push(diskPath);
          return;
        }

        if (isRetryable && attempt < MAX_RETRIES) {
          const delaySec = attempt * 2 + Math.random() * 3; // 2с, 4с, 6с...
          console.warn(
            `⚠ Попытка ${attempt}/${MAX_RETRIES} не удалась (${message}). Повтор через ${delaySec}с...`,
          );
          await new Promise((r) => setTimeout(r, delaySec * 1000));
          continue;
        }

        // Неретраибельная ошибка или закончились попытки
        console.error(`✗ Ошибка при скачивании ${diskPath}: ${message}`);
        this.failedFiles.push(diskPath);
        return;
      }
    }

    // На всякий случай (сюда почти не попадаем)
    const message = lastError instanceof Error ? lastError.message : String(lastError);
    console.error(`✗ Ошибка при скачивании ${diskPath}: ${message}`);
    this.failedFiles.push(diskPath);
  }

  /**
   * Получить всё содержимое папки (с пагинацией через offset).
   * Если файлов > 1000 — запрашивает следующие страницы.
   */
  async listFolder(diskPath: string): Promise<Resource[]> {
    const allItems: Resource[] = [];
    const limit = 1000;
    let offset = 0;
    let total = Infinity;

    while (offset < total) {
      const data = await this.apiGet<Resource>('/resources', {
        path: diskPath,
        limit: String(limit),
        offset: String(offset),
      });

      const embedded = data._embedded;
      if (!embedded) break;

      allItems.push(...(embedded.items ?? []));

      // total может отсутствовать в некоторых ответах — тогда останавливаемся,
      // когда получили меньше, чем запрашивали
      total = embedded.total ?? allItems.length;
      offset += limit;

      // Если пришло меньше limit — значит, это последняя страница
      if ((embedded.items?.length ?? 0) < limit) break;
    }

    return allItems;
  }

  /** Рекурсивно скачать папку (включая вложенные папки) */
  async downloadFolder(
    diskPath: string,
    localDir: string,
    options: { skipExisting?: boolean } = {},
  ): Promise<void> {
    await mkdir(localDir, { recursive: true });

    const items = await this.listFolder(diskPath);

    const dirs = items.filter((item) => item.type == 'dir');
    const files = items.filter((item) => item.type != 'dir');

    for (const item of dirs) {
      await this.downloadFolder(item.path, join(localDir, item.name), options);
    }

    await this.brigade.submitMany(
      files.map((item) => {
        return async () => {
          await new Promise((r) => setTimeout(r, Math.random() * 30 * 1000));
          const localPath = join(localDir, item.name);
          if (options.skipExisting) {
            try {
              await access(localPath);
              console.log(`↷ Пропущен (уже есть): ${localPath}`);
              return;
            } catch {
              // файла нет — скачиваем
            }
          }
          await this.downloadFile(item.path, localPath);
        };
      }),
    );
  }
}
