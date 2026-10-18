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
  private readonly brigade = new Brigade(10);

  constructor(
    private readonly token: string,
    private readonly apiBase: string = 'https://cloud-api.yandex.net/v1/disk',
  ) {}

  failedFiles: string[] = [];

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

    try {
      const href = await this.getDownloadLink(diskPath);

      const res = await fetch(href, {
        headers: {
          Authorization: `OAuth ${this.token}`,
        },
        redirect: 'follow',
      });

      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }

      await mkdir(dirname(localPath), { recursive: true });

      const fileStream = createWriteStream(localPath);
      // @ts-ignore — Readable.fromWeb есть в Node 18+
      await pipeline(Readable.fromWeb(res.body as any), fileStream);

      console.log(`✓ Готово: ${localPath}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`✗ Ошибка при скачивании ${diskPath}: ${message}`);
      this.failedFiles.push(diskPath);
    }
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
